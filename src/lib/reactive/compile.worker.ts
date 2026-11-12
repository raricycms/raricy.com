import { createLocalCompileSession, startLocalCompileWorker, type LocalCompileWorkerScope } from 'reactive-md';
import { compileSource } from './compile-source';

const session = createLocalCompileSession();
const compile = session.compile.bind(session);
const compileShared = session.compileShared.bind(session);
session.compile = (source, options) => compileSource(source, options, compile);
session.compileShared = (source, options) => compileSource(source, options, compileShared);
startLocalCompileWorker(self as unknown as LocalCompileWorkerScope, { createSession: () => session });
