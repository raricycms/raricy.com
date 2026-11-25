import {
  createLocalCompileSession,
  startLocalCompileWorker,
  type LocalCompileWorkerScope,
  type LocalSourcePhase,
} from 'reactive-md';
import { compileSource } from './compile-source';

const session = createLocalCompileSession();
const compile = session.compile.bind(session);
const compileShared = session.compileShared.bind(session);
session.compile = (source, options, sourcePhase?: LocalSourcePhase) =>
  compileSource(source, options, sourcePhase, compile);
session.compileShared = (source, options, sourcePhase?: LocalSourcePhase) =>
  compileSource(source, options, sourcePhase, compileShared);
startLocalCompileWorker(self as unknown as LocalCompileWorkerScope, { createSession: () => session });
