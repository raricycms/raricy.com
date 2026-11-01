import { LOCAL_SYNTAX_VERSION, localCompileOptionsKey } from 'reactive-md';
import { ADAPTER_VERSION } from './ref-adapter';
import { LEGACY_COMPAT_VERSION } from './legacy-compat';
import { REACTIVE_COMPILER_VERSION, reactiveCompileOptions } from './host-components';
import type { ContentFormat } from '../content-format';

/** 编译和检索的失效身份；与数据库、持久快照无关。 */
export function currentCompileSignature(format: ContentFormat) {
  return {
    syntaxVersion: LOCAL_SYNTAX_VERSION,
    compilerVersion: REACTIVE_COMPILER_VERSION,
    adapterVersion: `${ADAPTER_VERSION}|${LEGACY_COMPAT_VERSION}`,
    optionsKey: localCompileOptionsKey(reactiveCompileOptions(format)),
  };
}
