// ─────────────────────────────────────────────────────────────────────────────
// sql-format.ts —— 「SQL 格式化」的纯逻辑
//
// 【这是什么、不是什么 —— 页面文案必须照这个说】
//   这是**基于词法的缩进与换行**：把 SQL 切成词法单元（关键字 / 字符串 / 引号
//   标识符 / 注释 / 运算符 / 标点），再按「子句换行、列表缩进」排版。
//   它**不做语义级重写**：不解析 AST、不判断哪个词是列名还是类型名、不保证对
//   所有方言的扩展语法都漂亮。写成 `SELECT` 子句套子句、DDL 里一大堆列定义这类
//   结构时，输出会退化成「能看」而不是「漂亮」。别在页面上承诺「一键美化所有 SQL」。
//
// 【不变式（比排版重要）】
//   · 字符串字面量、引号标识符（`"..."` / `` `...` ``）、`--` 行注释与 `/* */` 块注释
//     的**内容一个字符都不改**。引号内的关键字不会被大写、不会被拆行。
//   · 只动「词与词之间的空白」。所有 token 文本原样输出，注释里的换行也原样保留。
//   · 方言只影响**三件事**：关键字集合（大写与子句识别）、`#` 是否算注释（仅 MySQL）、
//     单引号里的反斜杠是否算转义（仅 MySQL）。不要指望它校验方言语法。
//   · 关键字大写开关关闭时保留**源码里的大小写**（`select` 仍是 `select`），不做归一化。
//
// 【排版规则（读输出前先看这个）】
//   · 子句（SELECT / FROM / WHERE / GROUP BY / ORDER BY / HAVING / SET / VALUES /
//     RETURNING / INSERT INTO / DELETE FROM / UPDATE / WITH）各占一行；
//   · 子句内容缩进一级；同一层的逗号（函数参数之外的）换行；
//   · WHERE / ON 里的 AND / OR 换行，JOIN 系列换行；
//   · 括号里的子查询（`(` 后面紧跟 SELECT / WITH）整体再缩进一级，`)` 对齐到外层；
//   · 分号结束一条语句，下一条从行首开始。
// ─────────────────────────────────────────────────────────────────────────────

export type SqlDialect = 'generic' | 'mysql' | 'postgresql' | 'sqlite';

export interface SqlFormatOptions {
  dialect: SqlDialect;
  /** 关键字是否统一大写；关闭时保留源码大小写。 */
  uppercaseKeywords: boolean;
  /** 每级缩进的空格数。 */
  indentSize: 2 | 4;
}

export const SQL_DIALECTS: ReadonlyArray<{ value: SqlDialect; label: string; hint: string }> = [
  {
    value: 'generic',
    label: '通用 SQL',
    hint: '标准 SQL 关键字；`#` 不算注释、单引号里的反斜杠不算转义。',
  },
  {
    value: 'mysql',
    label: 'MySQL',
    hint: '`#` 开头的行算注释；单引号里支持反斜杠转义；反引号标识符。',
  },
  {
    value: 'postgresql',
    label: 'PostgreSQL',
    hint: '双引号标识符；ILIKE / RETURNING / ON CONFLICT 等按关键字处理；反引号不做特殊处理。',
  },
  {
    value: 'sqlite',
    label: 'SQLite',
    hint: '反引号与双引号都当标识符；PRAGMA / AUTOINCREMENT 等按关键字处理。',
  },
];

// ── 词法 ────────────────────────────────────────────────────────────────────

type TokenType =
  | 'word'
  | 'number'
  | 'string'
  | 'quoted'
  | 'line-comment'
  | 'block-comment'
  | 'punct'
  | 'operator';

interface Token {
  type: TokenType;
  /** 原样文本 —— 输出时一个字符都不改。 */
  text: string;
}

const MULTI_CHAR_OPERATORS = ['->>', '->', '::', '<=', '>=', '<>', '!=', '||', ':='];
const PUNCTUATION = '(),;.';

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_\u0080-\uFFFF]/.test(ch);
}

function isIdentifierPart(ch: string): boolean {
  return /[\w$\u0080-\uFFFF]/.test(ch);
}

function tokenize(sql: string, dialect: SqlDialect): Token[] {
  const tokens: Token[] = [];
  const backslashEscapes = dialect === 'mysql';
  const hashComments = dialect === 'mysql';
  const backtickIdentifiers = dialect === 'mysql' || dialect === 'sqlite' || dialect === 'generic';

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // 行注释：`--` 到行尾（MySQL 还认 `#`）。
    if ((ch === '-' && sql[i + 1] === '-') || (hashComments && ch === '#')) {
      let j = i;
      while (j < sql.length && sql[j] !== '\n') j += 1;
      tokens.push({ type: 'line-comment', text: sql.slice(i, j) });
      i = j;
      continue;
    }

    // 块注释：没闭合就吞到结尾（保留原文，让用户自己发现少了 `*/`）。
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const j = end === -1 ? sql.length : end + 2;
      tokens.push({ type: 'block-comment', text: sql.slice(i, j) });
      i = j;
      continue;
    }

    // 单引号字符串：`''` 转义；MySQL 额外认反斜杠转义。
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        if (backslashEscapes && sql[j] === '\\') {
          j += 2;
          continue;
        }
        j += 1;
      }
      tokens.push({ type: 'string', text: sql.slice(i, j) });
      i = j;
      continue;
    }

    // 引号标识符：双引号总是、反引号按方言。`""` / `` `` `` 为转义。
    if (ch === '"' || (backtickIdentifiers && ch === '`')) {
      const quote = ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      tokens.push({ type: 'quoted', text: sql.slice(i, j) });
      i = j;
      continue;
    }

    // 数字：十六进制 / 二进制 / 小数 / 指数。
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const match = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(sql.slice(i));
      if (match) {
        tokens.push({ type: 'number', text: match[0] });
        i += match[0].length;
        continue;
      }
    }

    // 普通词（关键字或标识符）。
    if (isIdentifierStart(ch)) {
      let j = i + 1;
      while (j < sql.length && isIdentifierPart(sql[j])) j += 1;
      tokens.push({ type: 'word', text: sql.slice(i, j) });
      i = j;
      continue;
    }

    // 多字符运算符（长的先试，`->>` 必须在 `->` 之前）。
    const multi = MULTI_CHAR_OPERATORS.find((op) => sql.startsWith(op, i));
    if (multi) {
      tokens.push({ type: 'operator', text: multi });
      i += multi.length;
      continue;
    }

    if (PUNCTUATION.includes(ch)) {
      tokens.push({ type: 'punct', text: ch });
      i += 1;
      continue;
    }

    // 其余单个字符（`= < > + - * / %` 等）都按运算符。
    tokens.push({ type: 'operator', text: ch });
    i += 1;
  }

  return tokens;
}

// ── 关键字 ──────────────────────────────────────────────────────────────────

const BASE_KEYWORDS: readonly string[] = [
  // 子句与谓词
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'RETURNING', 'WITH',
  'ON', 'USING', 'AS', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'TRUE', 'FALSE',
  'EXISTS', 'BETWEEN', 'LIKE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'DISTINCT', 'ALL', 'ASC', 'DESC', 'UNION', 'INTERSECT', 'EXCEPT',
  // 连接
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL',
  // DDL / 事务 / 其他
  'CREATE', 'TABLE', 'VIEW', 'INDEX', 'ALTER', 'DROP', 'PRIMARY', 'FOREIGN',
  'KEY', 'REFERENCES', 'CONSTRAINT', 'UNIQUE', 'CHECK', 'DEFAULT', 'CASCADE',
  'RESTRICT', 'TRUNCATE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION',
  'IF', 'REPLACE', 'IGNORE', 'EXPLAIN', 'ANALYZE', 'CONFLICT', 'DO', 'NOTHING',
  'OVER', 'PARTITION', 'WINDOW', 'FETCH', 'FIRST', 'NEXT', 'ROWS', 'ONLY',
  'FOR', 'NOWAIT', 'LOCK', 'SHARE', 'GENERATED', 'ALWAYS', 'IDENTITY',
  // 常见函数名：识别成关键字只为排版稳定，不是语法表
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST', 'ROUND',
  'LOWER', 'UPPER', 'LENGTH', 'SUBSTRING', 'TRIM', 'CONCAT', 'ABS', 'NOW',
  'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'CURRENT_TIME',
];

const DIALECT_KEYWORDS: Record<SqlDialect, readonly string[]> = {
  generic: [],
  mysql: [
    'AUTO_INCREMENT', 'UNSIGNED', 'ZEROFILL', 'ENGINE', 'CHARSET', 'COLLATE',
    'DUPLICATE', 'IFNULL', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'BIGINT', 'INT',
    'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT', 'BLOB', 'DATETIME', 'TIMESTAMP',
    'DELIMITER', 'STRAIGHT_JOIN', 'SQL_CALC_FOUND_ROWS', 'LOCK', 'UNLOCK',
  ],
  postgresql: [
    'RETURNING', 'SERIAL', 'BIGSERIAL', 'SMALLSERIAL', 'JSONB', 'JSON',
    'UUID', 'CONFLICT', 'NOTHING', 'LATERAL', 'INHERITS', 'MATERIALIZED',
    'REFRESH', 'VACUUM', 'ARRAY', 'TSVECTOR', 'TSQUERY', 'FILTER', 'WINDOW',
    'GENERATED', 'IDENTITY', 'ILIKE',
  ],
  sqlite: [
    'AUTOINCREMENT', 'WITHOUT', 'ROWID', 'PRAGMA', 'GLOB', 'ATTACH', 'DETACH',
    'VACUUM', 'REINDEX', 'UNION', 'CONFLICT', 'NOTHING',
  ],
};

const KEYWORDS: Record<SqlDialect, Set<string>> = {
  generic: new Set(BASE_KEYWORDS),
  mysql: new Set([...BASE_KEYWORDS, ...DIALECT_KEYWORDS.mysql]),
  postgresql: new Set([...BASE_KEYWORDS, ...DIALECT_KEYWORDS.postgresql]),
  sqlite: new Set([...BASE_KEYWORDS, ...DIALECT_KEYWORDS.sqlite]),
};

/** 函数名：它后面的 `(` 不加空格（`COUNT(` 而不是 `COUNT (`）。 */
const FUNCTION_KEYWORDS = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST', 'ROUND',
  'LOWER', 'UPPER', 'LENGTH', 'SUBSTRING', 'TRIM', 'CONCAT', 'ABS', 'NOW',
  'IFNULL', 'JSON_EXTRACT', 'DATE_TRUNC', 'ROW_NUMBER', 'RANK', 'DENSE_RANK',
]);

/** 这些关键字后面的 `(` 要有空格（`IN (`、`VALUES (`）。 */
const SPACE_BEFORE_PAREN_KEYWORDS = new Set([
  'IN', 'EXISTS', 'VALUES', 'AS', 'ON', 'USING', 'AND', 'OR', 'NOT', 'WHEN',
  'THEN', 'ELSE', 'BETWEEN', 'LIKE', 'ILIKE', 'BY', 'SELECT', 'FROM', 'WHERE',
  'GROUP', 'ORDER', 'HAVING', 'SET', 'RETURNING', 'WITH', 'ALL', 'DISTINCT',
  'CASE', 'JOIN',
]);

/** 会把内容缩进一级的子句（关键字之后换行）。 */
const LIST_CLAUSES = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'SET', 'VALUES',
  'RETURNING', 'WITH', 'INSERT INTO', 'DELETE FROM', 'UPDATE',
]);

/** 关键字与本行内容同行、不强制换行的子句。 */
const INLINE_CLAUSES = new Set(['LIMIT', 'OFFSET', 'UNION', 'UNION ALL', 'UNION DISTINCT', 'INTERSECT', 'EXCEPT']);

const JOIN_PREFIXES = new Set(['LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER', 'CROSS', 'NATURAL']);

// ── 排版 ────────────────────────────────────────────────────────────────────

type ClauseKind = 'list' | 'inline';

interface ClauseContext {
  kind: ClauseKind;
  /** 该子句开始时的括号深度 —— 只有同层的逗号才换行（函数参数里的逗号不换）。 */
  parenDepth: number;
}

interface Phrase {
  text: string;
  /** 该短语吃掉了几个 token。 */
  count: number;
  kind: 'list-clause' | 'inline-clause' | 'join' | 'condition' | 'keyword';
}

function upperOf(token: Token): string {
  return token.type === 'word' ? token.text.toUpperCase() : '';
}

/** 从 i 开始匹配一个多词短语 / 子句（只处理会影响排版的那几类）。 */
function phraseAt(tokens: readonly Token[], i: number, dialect: SqlDialect): Phrase | null {
  const token = tokens[i];
  if (!token || token.type !== 'word') return null;
  const word = upperOf(token);
  const keywords = KEYWORDS[dialect];
  if (!keywords.has(word)) return null;

  const next = tokens[i + 1];
  const nextWord = next ? upperOf(next) : '';

  const combine = (count: number, kind: Phrase['kind']): Phrase => ({
    text: tokens
      .slice(i, i + count)
      .map((part) => part.text)
      .join(' '),
    count,
    kind,
  });

  if (word === 'GROUP' && nextWord === 'BY') return combine(2, 'list-clause');
  if (word === 'ORDER' && nextWord === 'BY') return combine(2, 'list-clause');
  if (word === 'INSERT' && nextWord === 'INTO') return combine(2, 'list-clause');
  if (word === 'DELETE' && nextWord === 'FROM') return combine(2, 'list-clause');
  if (word === 'UNION') {
    if (nextWord === 'ALL' || nextWord === 'DISTINCT') return combine(2, 'inline-clause');
    return combine(1, 'inline-clause');
  }
  if (word === 'INTERSECT' || word === 'EXCEPT') return combine(1, 'inline-clause');
  if (word === 'LIMIT' || word === 'OFFSET') return combine(1, 'inline-clause');
  if (LIST_CLAUSES.has(word)) return combine(1, 'list-clause');

  // JOIN 系列：`LEFT` / `LEFT OUTER` / `RIGHT` … 与 `JOIN` 合成一个短语。
  if (word === 'JOIN') return combine(1, 'join');
  if (JOIN_PREFIXES.has(word)) {
    if (nextWord === 'JOIN') return combine(2, 'join');
    const third = tokens[i + 2] ? upperOf(tokens[i + 2]) : '';
    if (nextWord === 'OUTER' && third === 'JOIN') return combine(3, 'join');
  }

  if (word === 'AND' || word === 'OR') return combine(1, 'condition');
  return combine(1, 'keyword');
}

/** 格式化入口。不做语法校验；无法识别的词一律原样保留。 */
export function formatSql(source: string, options: SqlFormatOptions): string {
  const tokens = tokenize(source, options.dialect);
  if (tokens.length === 0) return '';

  const unit = ' '.repeat(options.indentSize);
  const keywords = KEYWORDS[options.dialect];
  const output: string[] = [];

  let line = '';
  let lineStarted = false;
  let lineLevel = 0;
  let needSpace = false;

  let subDepth = 0;
  let parenDepth = 0;
  const parenIsSubquery: boolean[] = [];
  const clauseStack: Array<ClauseContext | null> = [];
  /** 进入子查询前的 subDepth —— 关闭括号时**恢复**，不能简单 -1（缩进是绝对层级）。 */
  const subDepthStack: number[] = [];
  let clause: ClauseContext | null = null;
  let prevToken: Token | null = null;

  /** 当前子句的内容行缩进级别；不在子句里就对齐到当前子查询层级。 */
  function contentLevel(): number {
    return clause ? subDepth + 1 : subDepth;
  }

  function flushLine(): void {
    if (!lineStarted) return;
    output.push(unit.repeat(lineLevel) + line.replace(/[ \t]+$/, ''));
    line = '';
    lineStarted = false;
  }

  function write(text: string, level: number, withSpace: boolean): void {
    if (!lineStarted) {
      lineLevel = level;
      lineStarted = true;
      line = text;
      return;
    }
    if (withSpace && !line.endsWith(' ')) line += ' ';
    line += text;
  }

  function keywordText(raw: string): string {
    // 组合短语按词分开处理，保证 `group   by` 这类怪空白不会带进输出。
    return raw
      .split(' ')
      .map((part) => (options.uppercaseKeywords ? part.toUpperCase() : part))
      .join(' ');
  }

  function structuralSpaceBeforeParen(prev: Token | null): boolean {
    if (!prev) return false;
    if (prev.type === 'operator') return true;
    if (prev.type !== 'word') return false;
    return SPACE_BEFORE_PAREN_KEYWORDS.has(upperOf(prev));
  }

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];

    // ── 注释 ────────────────────────────────────────────────────────────────
    if (token.type === 'line-comment') {
      write(token.text, contentLevel(), lineStarted);
      flushLine();
      needSpace = false;
      prevToken = token;
      i += 1;
      continue;
    }
    if (token.type === 'block-comment') {
      if (token.text.includes('\n')) {
        flushLine();
        const commentLines = token.text.split('\n');
        write(commentLines[0], contentLevel(), false);
        flushLine();
        for (let k = 1; k < commentLines.length; k += 1) output.push(commentLines[k]);
        needSpace = true;
      } else {
        write(token.text, contentLevel(), lineStarted || needSpace);
        needSpace = true;
      }
      prevToken = token;
      i += 1;
      continue;
    }

    // ── 短语 / 关键字 ───────────────────────────────────────────────────────
    const phrase = phraseAt(tokens, i, options.dialect);
    if (phrase) {
      switch (phrase.kind) {
        case 'list-clause': {
          flushLine();
          write(keywordText(phrase.text), subDepth, false);
          // 子句后面没有内容（直接跟 `;` / 右括号 / 文件结尾）时不要换行，
          // 否则会留下一个只写着 `;` 的孤行。
          const afterClause = tokens[i + phrase.count];
          const hasContent =
            afterClause !== undefined &&
            !(afterClause.type === 'punct' && (afterClause.text === ';' || afterClause.text === ')'));
          if (hasContent) {
            flushLine();
            clause = { kind: 'list', parenDepth };
            needSpace = false;
          } else {
            clause = { kind: 'inline', parenDepth };
            needSpace = false;
          }
          break;
        }
        case 'inline-clause': {
          flushLine();
          write(keywordText(phrase.text), subDepth, false);
          clause = { kind: 'inline', parenDepth };
          needSpace = true;
          break;
        }
        case 'join': {
          flushLine();
          write(keywordText(phrase.text), contentLevel(), false);
          needSpace = true;
          break;
        }
        case 'condition': {
          flushLine();
          write(keywordText(phrase.text), contentLevel(), false);
          needSpace = true;
          break;
        }
        case 'keyword': {
          write(keywordText(phrase.text), contentLevel(), needSpace && lineStarted);
          needSpace = true;
          break;
        }
      }
      prevToken = tokens[i + phrase.count - 1] ?? token;
      i += phrase.count;
      continue;
    }

    // ── 标点 ────────────────────────────────────────────────────────────────
    if (token.type === 'punct') {
      switch (token.text) {
        case '(': {
          const next = tokens[i + 1];
          const nextWord = next ? upperOf(next) : '';
          const isSubquery = nextWord === 'SELECT' || nextWord === 'WITH';
          write('(', contentLevel(), structuralSpaceBeforeParen(prevToken));
          needSpace = false;
          parenIsSubquery.push(isSubquery);
          parenDepth += 1;
          if (isSubquery) {
            // 子查询整体比「当前这一行」再缩进一级：子句关键字对齐到 `(` 所在行的
            // 下一级，内容再下一级。所以 subDepth 直接取「当前内容行级别 + 1」。
            const innerBase = contentLevel() + 1;
            flushLine();
            clauseStack.push(clause);
            subDepthStack.push(subDepth);
            clause = null;
            subDepth = innerBase;
          }
          break;
        }
        case ')': {
          const wasSubquery = parenIsSubquery.pop() ?? false;
          parenDepth = Math.max(0, parenDepth - 1);
          if (wasSubquery) {
            subDepth = subDepthStack.pop() ?? Math.max(0, subDepth - 1);
            flushLine();
            clause = clauseStack.pop() ?? null;
            write(')', contentLevel(), false);
          } else {
            write(')', contentLevel(), false);
          }
          needSpace = true;
          break;
        }
        case ',': {
          write(',', contentLevel(), false);
          if (clause && clause.kind === 'list' && parenDepth === clause.parenDepth) {
            flushLine();
            needSpace = false;
          } else {
            needSpace = true;
          }
          break;
        }
        case ';': {
          write(';', contentLevel(), false);
          flushLine();
          clause = null;
          needSpace = false;
          break;
        }
        case '.': {
          write('.', contentLevel(), false);
          needSpace = false;
          break;
        }
        default:
          break;
      }
      prevToken = token;
      i += 1;
      continue;
    }

    // ── 运算符 ──────────────────────────────────────────────────────────────
    if (token.type === 'operator') {
      const tight = token.text === '::' || token.text === '->' || token.text === '->>';
      // 一元正负号：紧贴后面的数字（`-1`），不写成 `- 1`。
      const unary =
        (token.text === '-' || token.text === '+') &&
        (prevToken === null ||
          prevToken.type === 'operator' ||
          (prevToken.type === 'punct' && (prevToken.text === '(' || prevToken.text === ',')));
      if (tight) {
        write(token.text, contentLevel(), false);
        needSpace = false;
      } else if (unary) {
        write(token.text, contentLevel(), false);
        needSpace = false;
      } else {
        write(token.text, contentLevel(), lineStarted);
        needSpace = true;
      }
      prevToken = token;
      i += 1;
      continue;
    }

    // ── 字符串 / 引号标识符 / 数字 / 普通词 ─────────────────────────────────
    if (token.type === 'string' || token.type === 'quoted' || token.type === 'number') {
      write(token.text, contentLevel(), lineStarted && needSpace);
      needSpace = true;
      prevToken = token;
      i += 1;
      continue;
    }

    // word 但不在关键字集合里：普通标识符，原样保留大小写。
    write(token.text, contentLevel(), lineStarted && needSpace);
    needSpace = true;
    prevToken = token;
    i += 1;
  }

  flushLine();
  return output.join('\n');
}

/** 关键字 / 方言相关的辅助：页面用来渲染提示，不上屏也不改输出。 */
export function sqlKeywordUppercaseHint(): string {
  return '关键字大写只影响被识别为关键字的词；字符串与引号标识符里的内容永远不会被改。';
}

/** 供单测断言「识别成关键字的词」用（页面不直接用）。 */
export function isSqlKeyword(word: string, dialect: SqlDialect): boolean {
  const upper = word.toUpperCase();
  if (FUNCTION_KEYWORDS.has(upper)) return KEYWORDS[dialect].has(upper);
  return KEYWORDS[dialect].has(upper);
}
