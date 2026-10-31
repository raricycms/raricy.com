'use client';

// JSON 树形查看器：解析后递归渲染可折叠的树。
//
// 【节点过多时到底限制什么】
//   超过 2000 个节点就不再无限渲染，改成**有界渲染**：
//     · 每个对象 / 数组最多渲染前 200 个子项；
//     · 从根往下，逐层累计「渲染预算」不超过 2000 个节点（预算允许到第几层就渲染到第几层，
//       最多 3 层）。
//   只限制深度是不够的：一层 200 项、展开 3 层就是 800 万行 DOM，照样卡死页面。
//   所以按**实际树形**算出一个安全深度，页面上写明这次渲染到第几层。
//   截断只影响展示，解析出的数据本身是完整的。
//
// 【展开状态】
//   默认展开 2 层（根 + 第一层）。「全部展开 / 全部收起」改的是模式；单个节点的手动
//   开合记在 overrides 里（覆盖模式），所以先点「全部展开」再点某个节点收起是符合
//   直觉的。
import { useCallback, useMemo, useState } from 'react';
import { countJsonNodes, parseJsonText, type JsonErrorLocation } from '@/lib/dev-tools/json';

/** 节点数超过这个值就进入有界渲染。 */
const TREE_NODE_LIMIT = 2000;
/** 默认展开层数（根算第 0 层）。 */
const TREE_DEFAULT_DEPTH = 2;
/** 有界渲染时最多渲染到根以下第几层。 */
const TREE_MAX_DEPTH = 3;
/** 有界渲染时，单个对象 / 数组最多渲染多少个子项。 */
const TREE_BREADTH_LIMIT = 200;

type ExpandMode = 'default' | 'all' | 'none';

interface RenderLimit {
  /** 最多渲染到根以下第几层。 */
  depth: number;
  /** 单个容器最多渲染多少个子项。 */
  breadth: number;
}

/**
 * 按实际树形算出「只渲染前几层」的深度：
 * 逐层累计节点数（每层每个容器最多 breadth 项），直到会超过 TREE_NODE_LIMIT。
 * 至少渲染一层 —— 根的每个子容器最多 200 项，所以第一层本身一定在预算内。
 */
function computeRenderLimit(root: unknown, nodeCount: number): RenderLimit | null {
  if (nodeCount <= TREE_NODE_LIMIT) return null;

  const childrenOf = (node: unknown): unknown[] => {
    if (Array.isArray(node)) return node.slice(0, TREE_BREADTH_LIMIT);
    if (node !== null && typeof node === 'object') {
      return Object.values(node as Record<string, unknown>).slice(0, TREE_BREADTH_LIMIT);
    }
    return [];
  };

  let level: unknown[] = [root];
  let total = 1;
  let depth = 0;
  while (level.length > 0 && depth < TREE_MAX_DEPTH) {
    const next: unknown[] = [];
    for (const node of level) next.push(...childrenOf(node));
    if (next.length === 0) break;
    if (total + next.length > TREE_NODE_LIMIT && depth > 0) break;
    total += next.length;
    depth += 1;
    level = next;
  }

  return { depth: Math.max(1, depth), breadth: TREE_BREADTH_LIMIT };
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  switch (typeof value) {
    case 'string':
      return '字符串';
    case 'number':
      return '数字';
    case 'boolean':
      return '布尔';
    default:
      return '对象';
  }
}

function scalarClass(value: unknown): 'string' | 'number' | 'boolean' | 'null' {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'null';
  }
}

/** 标量预览：字符串转义 + 超长截断（150 字符），null / 布尔 / 数字直接显示。 */
function previewScalar(value: unknown): string {
  if (typeof value === 'string') {
    const clipped = value.length > 150 ? `${value.slice(0, 150)}…` : value;
    return JSON.stringify(clipped);
  }
  if (value === null) return 'null';
  return String(value);
}

interface TreeNodeProps {
  value: unknown;
  /** 对象键（根 / 数组元素为 null）。 */
  keyName: string | null;
  /** 数组下标（对象成员 / 根为 null）。 */
  index: number | null;
  isRoot: boolean;
  path: string;
  depth: number;
  /** null 表示不限制（节点数没超）。 */
  limit: RenderLimit | null;
  isExpanded: (path: string, depth: number) => boolean;
  onToggle: (path: string, depth: number) => void;
}

function TreeNode({ value, keyName, index, isRoot, path, depth, limit, isExpanded, onToggle }: TreeNodeProps) {
  const isArray = Array.isArray(value);
  const isObject = value !== null && typeof value === 'object' && !isArray;

  const children = useMemo(() => {
    if (isArray) {
      return (value as unknown[]).map((child, childIndex) => ({
        value: child,
        keyName: null as string | null,
        index: childIndex as number | null,
        path: `${path}[${childIndex}]`,
      }));
    }
    if (isObject) {
      return Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => ({
        value: childValue,
        keyName: childKey as string | null,
        index: null as number | null,
        path: `${path}.${encodeURIComponent(childKey)}`,
      }));
    }
    return [];
  }, [isArray, isObject, path, value]);

  const shownChildren = limit === null ? children : children.slice(0, limit.breadth);
  const hiddenCount = children.length - shownChildren.length;
  const expandable = children.length > 0;
  const expanded = expandable && isExpanded(path, depth);
  const reachedDepthLimit = limit !== null && depth + 1 > limit.depth;

  return (
    <div>
      <div className="devtool-tree__row">
        {expandable ? (
          <button
            type="button"
            className="devtool-tree__toggle"
            onClick={() => onToggle(path, depth)}
            aria-expanded={expanded}
            aria-label={expanded ? '收起' : '展开'}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="devtool-tree__toggle devtool-tree__toggle--placeholder" aria-hidden="true" />
        )}
        {isRoot ? (
          <span className="devtool-tree__index">$</span>
        ) : keyName !== null ? (
          <span className="devtool-tree__key">{keyName}</span>
        ) : (
          <span className="devtool-tree__index">[{index}]</span>
        )}
        <span className="devtool-tree__type">
          {isArray || isObject ? `${typeName(value)} · ${children.length} 项` : typeName(value)}
        </span>
        {!isArray && !isObject && (
          <span className={`devtool-tree__value devtool-tree__value--${scalarClass(value)}`}>
            {previewScalar(value)}
          </span>
        )}
        {(isArray || isObject) && children.length === 0 && (
          <span className="devtool-tree__value devtool-tree__value--empty">
            {isArray ? '[]' : '{}'}
          </span>
        )}
      </div>

      {expanded && (
        <div className="devtool-tree__children">
          {reachedDepthLimit ? (
            <p className="devtool-tree__more">
              已到渲染深度上限（根以下 {limit?.depth ?? 0} 层），更深的节点没有渲染
            </p>
          ) : (
            <>
              {shownChildren.map((child) => (
                <TreeNode
                  key={child.path}
                  value={child.value}
                  keyName={child.keyName}
                  index={child.index}
                  isRoot={false}
                  path={child.path}
                  depth={depth + 1}
                  limit={limit}
                  isExpanded={isExpanded}
                  onToggle={onToggle}
                />
              ))}
              {hiddenCount > 0 && (
                <p className="devtool-tree__more">…还有 {hiddenCount} 项未渲染</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface TreeState {
  value: unknown;
  nodeCount: number;
  limit: RenderLimit | null;
}

export default function JsonTreeTool() {
  const [input, setInput] = useState('');
  const [tree, setTree] = useState<TreeState | null>(null);
  const [error, setError] = useState<{ message: string; location: JsonErrorLocation | null } | null>(null);
  const [mode, setMode] = useState<ExpandMode>('default');
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState('');

  const isExpanded = useCallback(
    (path: string, depth: number) => {
      if (Object.prototype.hasOwnProperty.call(overrides, path)) return overrides[path];
      if (mode === 'all') return true;
      if (mode === 'none') return false;
      return depth < TREE_DEFAULT_DEPTH;
    },
    [mode, overrides],
  );

  const onToggle = useCallback(
    (path: string, depth: number) => {
      setOverrides((previous) => ({ ...previous, [path]: !isExpanded(path, depth) }));
    },
    [isExpanded],
  );

  function parseInput() {
    const result = parseJsonText(input);
    if (!result.ok) {
      setTree(null);
      setError({ message: result.message, location: result.location });
      setStatus('');
      return;
    }
    const nodeCount = countJsonNodes(result.value);
    setTree({ value: result.value, nodeCount, limit: computeRenderLimit(result.value, nodeCount) });
    setError(null);
    setMode('default');
    setOverrides({});
    setStatus(`已解析，共 ${nodeCount} 个节点`);
  }

  function expandAll() {
    setMode('all');
    setOverrides({});
  }

  function collapseAll() {
    setMode('none');
    setOverrides({});
  }

  const limited = tree !== null && tree.limit !== null;

  return (
    <div className="devtool-stack">
      <div className="tool-panel">
        <div className="devtool-bar">
          <label className="form-label" htmlFor="devtool-tree-input">
            输入 JSON
          </label>
          <span className="devtool-bar__spacer" />
          <button type="button" className="btn btn-primary" onClick={parseInput}>
            解析
          </button>
          <button
            type="button"
            className="btn btn-outline-secondary"
            onClick={expandAll}
            disabled={tree === null}
          >
            全部展开
          </button>
          <button
            type="button"
            className="btn btn-outline-secondary"
            onClick={collapseAll}
            disabled={tree === null}
          >
            全部收起
          </button>
        </div>
        <textarea
          id="devtool-tree-input"
          className="devtool-input"
          rows={8}
          value={input}
          spellCheck={false}
          onChange={(event) => {
            setInput(event.target.value);
            setTree(null);
            setError(null);
            setStatus('');
          }}
          placeholder="粘贴要查看的 JSON，然后点「解析」"
        />
        {error && (
          <div className="devtool-error-block">
            <p className="devtool-error">{error.message}</p>
            {error.location && (
              <>
                <p className="devtool-hint">
                  第 {error.location.line} 行第 {error.location.column} 列
                </p>
                <pre className="devtool-output devtool-output--error">{error.location.snippet}</pre>
              </>
            )}
          </div>
        )}
      </div>

      {tree !== null && (
        <div className="tool-panel">
          <div className="devtool-bar">
            <span className="devtool-status">{status}</span>
            <span className="devtool-bar__spacer" />
            {tree.limit !== null && (
              <span className="devtool-badge devtool-badge--warn">
                节点超过 {TREE_NODE_LIMIT}，只渲染前 {tree.limit.depth} 层
              </span>
            )}
          </div>
          {limited && tree.limit !== null && (
            <p className="devtool-hint">
              这棵树共有 {tree.nodeCount} 个节点，超过 {TREE_NODE_LIMIT} 的展示上限。为避免页面卡顿，
              只渲染根以下 {tree.limit.depth} 层、每个容器最多 {tree.limit.breadth} 项
              （解析结果本身是完整的）。
            </p>
          )}
          <div className="devtool-tree devtool-scroll">
            <TreeNode
              value={tree.value}
              keyName={null}
              index={null}
              isRoot
              path="$"
              depth={0}
              limit={tree.limit}
              isExpanded={isExpanded}
              onToggle={onToggle}
            />
          </div>
        </div>
      )}
    </div>
  );
}
