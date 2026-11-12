import type { LocalCompileOptions } from 'reactive-md';

export const SITE_EMBED_TAG = 'site-embed';
export const REACTIVE_COMPILER_VERSION = 'reactive-md/0.8.0';
export const REACTIVE_MAX_SYNTAX_NODES = 50_000;

export const REACTIVE_COMPILE_OPTIONS: LocalCompileOptions = {
  strict: false,
  markdownBreaks: true,
  limits: { maxSyntaxNodes: REACTIVE_MAX_SYNTAX_NODES, maxParseWork: 1_000_000 },
};
