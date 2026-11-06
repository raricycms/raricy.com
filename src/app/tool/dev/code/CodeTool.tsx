'use client';

// 代码格式化：词法级「基础缩进」。
//
// 六个语言走两种路径：JSON 真解析（语法错误要报出来），其余走词法缩进（尽力输出、
// 不抛「无法格式化」）。字符串 / 模板串 / 正则 / 注释在词法阶段被整段跳过，内容不改；
// HTML 的 pre / textarea / script / style 内部原文整段保留。这不是 Prettier。
import { useMemo, useState } from 'react';
import { CODE_LANGUAGES, formatCode, type CodeLanguage } from '@/lib/dev-tools/code-format';

const INDENT_OPTIONS = [2, 4] as const;

const SAMPLES: Record<CodeLanguage, string> = {
  json: '{"name":"聪明山","tags":["工具","开发"],"count":2}',
  javascript:
    "function greet(name){if(!name){return '匿名'}return `Hello, ${name}!`}const list=[1,2,3].map(x=>x*2);",
  typescript:
    "interface User{id:number;name?:string}function greet(user:User):string{return `Hi ${user.name ?? 'guest'}`}",
  css: '.card{color:#2563eb;padding:12px 16px;background:url("/x.png") no-repeat}.card:hover{color:#1d4ed8}',
  html: '<div class="card"><p>Hello</p><img src="a.png"><ul><li>一</li><li>二</li></ul></div>',
  xml: '<?xml version="1.0"?><root><item id="1">text</item><item id="2"/></root>',
};

export default function CodeTool() {
  const [language, setLanguage] = useState<CodeLanguage>('javascript');
  const [indentSize, setIndentSize] = useState<2 | 4>(2);
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');

  const result = useMemo((): { output: string; error: string | null } => {
    if (source.trim() === '') return { output: '', error: null };
    try {
      return { output: formatCode(source, language, indentSize), error: null };
    } catch (error) {
      return {
        output: '',
        error: error instanceof Error && error.message ? error.message : '格式化失败',
      };
    }
  }, [source, language, indentSize]);

  const languageDef = CODE_LANGUAGES.find((entry) => entry.value === language);

  async function copyOutput(): Promise<void> {
    if (result.output === '') return;
    try {
      await navigator.clipboard.writeText(result.output);
      setStatus('已复制格式化结果');
    } catch {
      setStatus('复制失败（浏览器未授予剪贴板权限）');
    }
  }

  return (
    <div>
      <div className="devtool-bar">
        <label className="form-label" htmlFor="code-language">
          语言
        </label>
        <select
          id="code-language"
          className="form-select devtool-field--select"
          value={language}
          onChange={(event) => {
            setLanguage(event.target.value as CodeLanguage);
            setStatus('');
          }}
        >
          {CODE_LANGUAGES.map((entry) => (
            <option value={entry.value} key={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>

        <label className="form-label" htmlFor="code-indent">
          缩进
        </label>
        <select
          id="code-indent"
          className="form-select devtool-field--select"
          value={indentSize}
          onChange={(event) => {
            setIndentSize(event.target.value === '4' ? 4 : 2);
            // 缩进影响结果：旧状态（如「已复制」）立即失效（R3-483）。
            setStatus('');
          }}
        >
          {INDENT_OPTIONS.map((size) => (
            <option value={size} key={size}>
              {size} 空格
            </option>
          ))}
        </select>

        <span className="devtool-bar__spacer" />
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => {
            setSource(SAMPLES[language]);
            setStatus('');
          }}
        >
          填入示例
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => {
            setSource('');
            setStatus('');
          }}
        >
          清空
        </button>
      </div>

      <p className="devtool-hint">{languageDef?.hint}</p>

      <div className="devtool-split devtool-split--left">
        <div>
          <label className="form-label" htmlFor="code-source">
            原始代码
          </label>
          <textarea
            id="code-source"
            className="devtool-input"
            rows={14}
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              // 改输入后「已复制 / 复制失败」必须失效（R3-483）。
              setStatus('');
            }}
            placeholder="粘贴代码；字符串、模板串、正则与注释里的内容不会被改动"
            spellCheck={false}
          />
        </div>
        <div>
          <div className="devtool-bar">
            <label className="form-label">格式化结果</label>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary devtool-bar__spacer"
              onClick={copyOutput}
              disabled={result.output === ''}
            >
              复制
            </button>
          </div>
          <pre className={result.error !== null ? 'devtool-output devtool-output--error' : 'devtool-output'}>
            {result.error !== null ? result.error : result.output}
          </pre>
        </div>
      </div>

      <p className="devtool-hint">
        这是「基础缩进格式化」：花括号缩进、分号换行、标签嵌套缩进。它不换行超长表达式、
        不重排对象键、不处理 ASI 边界，也不做语法校验（JSON 除外）。
      </p>
      <p className="devtool-status">{status}</p>
    </div>
  );
}
