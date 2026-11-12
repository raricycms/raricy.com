import { LOCAL_SYNTAX_VERSION, localCompileOptionsKey } from 'reactive-md';
import { ADAPTER_VERSION } from './ref-adapter';
import { REACTIVE_COMPILER_VERSION, REACTIVE_COMPILE_OPTIONS } from './host-components';

/** 编译和检索的失效身份；与数据库、持久快照无关。 */
export function currentCompileSignature() {
  return {
    syntaxVersion: LOCAL_SYNTAX_VERSION,
    compilerVersion: REACTIVE_COMPILER_VERSION,
    adapterVersion: ADAPTER_VERSION,
    optionsKey: localCompileOptionsKey(REACTIVE_COMPILE_OPTIONS),
  };
}
