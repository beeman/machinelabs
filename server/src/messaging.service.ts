import * as firebase from 'firebase';
import { Crypto } from './util/crypto';
import { environment } from './environments/environment';
import { db, DbRefBuilder } from './ml-firebase';
import { CodeRunner, ProcessStreamData } from './code-runner/code-runner';
import { Observable } from '@reactivex/rxjs';
import { Invocation, InvocationType } from './models/invocation';
import { Execution, ExecutionStatus, ExecutionMessage, MessageKind, toMessageKind } from './models/execution';
import { RulesService } from 'rules.service';
import { Server } from 'models/server';

export class MessagingService {

  db = new DbRefBuilder();
  server: Server;

  constructor(private rulesService: RulesService,
              private codeRunner: CodeRunner) {
  }

  init() {

    this.db.serverRef(environment.serverId).onceValue()
        .map(snapshot => snapshot.val())
        .subscribe(server => {
          this.server = server;
          this.initMessaging();
        });
  }

  initMessaging () {
    // Listen on all incoming runs to do the right thing
    this.db.newInvocationsForServerRef(this.server.id).childAdded()
        .map(snapshot => snapshot.val())
        .switchMap(invocation => this.getOutputAsObservable(invocation))
        .switchMap(data => this.writeExecutionMessage(data.output, data.invocation))
        .subscribe();

    // Listen on all changed runs to get notified about stops
    this.db.invocationsRef().childChanged()
        .map(snapshot => snapshot.val())
        .filter(execution => execution.type === InvocationType.StopExecution)
        .subscribe(execution => this.codeRunner.stop(execution));
  }

  /**
   * Take a run and observe the output. The run maybe cached or rejected
   * but it is guaranteed to get some message back.
   */
  getOutputAsObservable(invocation: Invocation) : Observable<any> {
    console.log(`Starting new run ${invocation.id}`);

    // check if we have existing output for the requested run
    let hash = Crypto.hashLabFiles(invocation.data);
    return this.getExistingExecutionAsObservable(hash)
               .switchMap(execution => {
                  // if we do have output, send a redirect message
                  if (execution) {
                    console.log('redirecting output');
                    return Observable.of({
                              kind: MessageKind.OutputRedirected,
                              data: '' + execution.id
                            });
                  }

                  // otherwise, try to get approval
                  return this.rulesService
                              .getApproval(invocation)
                              .switchMap(approval => {
                                if (approval.allowExecution) {
                                  // if we get the approval, create the meta data
                                  this.createExecutionAndUpdateLabs(invocation, hash);
                                  // and execute the code
                                  return this.codeRunner
                                            .run(invocation)
                                            .map(data => this.processStreamDataToExecutionMessage(data))
                                            .concat(Observable.of({
                                              kind: MessageKind.ExecutionFinished,
                                              data: ''
                                            }))
                                            .do(msg => {
                                              if (msg.kind === MessageKind.ExecutionFinished){
                                                this.completeExecution(invocation);
                                              }
                                            })
                                }

                                // if we don't get an approval, reject it
                                return Observable.of({
                                  kind: MessageKind.ExecutionRejected,
                                  data: approval.message
                                });
                              });

              })
              .map(output => ({output, invocation}));
  }

  createExecutionAndUpdateLabs(invocation: Invocation, hash: string) {
    this.db.executionRef(invocation.id)
      .set({
        id: invocation.id,
        file_set_hash: hash,
        server_info: this.server.info || '',
        started_at: firebase.database.ServerValue.TIMESTAMP,
        user_id: invocation.user_id,
        lab_id: invocation.data.id,
        status: ExecutionStatus.Executing
      })
      .switchMap(_ => this.db.labsForHashRef(hash).onceValue())
      .map(snapshot => snapshot.val())
      .subscribe(labs => {

        let updates = Object.keys(labs || {})
          .map(key => labs[key])
          .reduce((prev, lab) => (prev[`/labs/${lab.id}/has_cached_run`] = true) && prev, {});

        let updateCount = Object.keys(updates).length;

        console.log(`Updating ${updateCount} labs with associated run`);
        // This updates all labs at once
        this.db.rootRef().update(updates);
      });
  }

  completeExecution(run: Invocation) {
    this.db.executionRef(run.id)
      .update({
        finished_at: firebase.database.ServerValue.TIMESTAMP,
        status: ExecutionStatus.Finished
      });
  }

  /**
   * Gets an Observable<Execution> that emits once with either null or an existing output 
   */
  getExistingExecutionAsObservable(fileSetHash: string) : Observable<Execution> {
    return this.db.executionByHashRef(fileSetHash)
                  .onceValue()
                  .map(snapshot => snapshot.val())
                  .map(val => val ? val[Object.keys(val)[0]] : null);
  }

  processStreamDataToExecutionMessage(data: ProcessStreamData): ExecutionMessage {
    return {
      data: data.str,
      kind: toMessageKind(data.origin)
    };
  }

  writeExecutionMessage(data: ExecutionMessage, run: Invocation) {
    let id = db.ref().push().key;
    data.id = id;
    data.timestamp = firebase.database.ServerValue.TIMESTAMP;
    return this.db.executionMessageRef(run.id, id).set(data);
  }
}
