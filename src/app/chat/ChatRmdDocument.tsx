'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatRmdDocument.tsx — 聊天静态 RMD 文档的内层渲染器（正文与子剪贴板共用）
//
// 只做三件事：为文档创建/替换 runtime、把聊天静态能力契约钉死、把宿主组件
// 形状修正到上游能调用 hostRenderer 的形态。
//
// 【为什么在这里把 chat-ref 的 hostForm 改成 inline】引用适配器生成的宿主节点是
// `leaf` + 只有一个 `slot` 属性；上游 `LocalDocumentView` 对「没有 kind/ref 且不是
// inline/container」的节点会直接渲染 `local-host-unavailable` 占位、**不调用**
// hostRenderer。聊天视图按 slot 从 hostData 取数据，本来就不走上游的 kind:ref
// 查表，因此这里把 chat-ref 统一成 inline —— 只影响调用路径，不改节点数据或预算。
// （适配器侧若改成 inline，这个归一化就退化为 no-op。）
//
// 【runtime 生命周期】与 `components/reactive/CompiledDocumentView.tsx` 同一套
// StrictMode 安全写法：文档身份变化时新建 runtime，卸载后用一个微任务确认没有
// 被开发态立即重挂，再 dispose。
// ─────────────────────────────────────────────────────────────────────────────

import 'reactive-md/styles/minimal.css';

import { useEffect, useMemo, useState } from 'react';
import { createLocalRuntime, type LocalDocument, type LocalRuntime } from 'reactive-md';
import {
  LocalDocumentView,
  type LocalUrlPolicy,
} from 'reactive-md/react/minimal';
import type { LocalHostData, LocalHostRenderer } from 'reactive-md/react/unstyled';
import { CHAT_REF_HOST_TAG, CHAT_REF_SLOT_ATTR, isChatHostData } from '@/lib/chat-rmd/reference-types';

/** 聊天静态挂载的能力上限：三项全关（编译期策略之外的运行时第二道闸）。 */
export const CHAT_RMD_CAPABILITY_GRANTS = Object.freeze({
  enableCss: false,
  enableJavaScript: false,
  enableExtendedHtml: false,
});

function normalizeHostForms(nodes: LocalDocument['nodes']): LocalDocument['nodes'] {
  let changed = false;
  const next = nodes.map((node) => {
    if (
      node.type === 'hostComponent' &&
      node.name === CHAT_REF_HOST_TAG &&
      node.hostForm !== 'inline' &&
      node.hostForm !== 'container'
    ) {
      changed = true;
      return { ...node, hostForm: 'inline' as const };
    }
    if (node.children) {
      const children = normalizeHostForms(node.children);
      if (children !== node.children) {
        changed = true;
        return { ...node, children };
      }
    }
    return node;
  });
  return changed ? next : nodes;
}

function isInlineDocumentHost(node: LocalDocument['nodes'][number], hostData: LocalHostData | undefined): boolean {
  if (node.type !== 'hostComponent' || node.name !== CHAT_REF_HOST_TAG) return false;
  const slot = node.attrs?.[CHAT_REF_SLOT_ATTR];
  if (typeof slot !== 'string') return false;
  const payload = hostData?.[slot];
  return isChatHostData(payload) && payload.kind === 'clipboard' && payload.document !== undefined;
}

/**
 * 把内联子文档的宿主节点从段落 / 强调等行内容器里提出来。
 *
 * 子剪贴板渲染的是 `<article>`（块级），留在 `<p>` 里是非法嵌套（React 会报
 * hydration 警告，浏览器解析与客户端 DOM 也会分叉）。与博客适配器 `splitFlow`
 * 同一个目的：只调整宿主节点的挂载层级，不改文字与顺序。
 */
function liftInlineDocuments(
  nodes: LocalDocument['nodes'],
  hostData: LocalHostData | undefined,
  nextPartId: () => number
): LocalDocument['nodes'] {
  let changed = false;
  const result: LocalDocument['nodes'] = [];

  for (const node of nodes) {
    if (!node.children?.length) {
      result.push(node);
      continue;
    }

    const children: LocalDocument['nodes'] = [];
    let slice: LocalDocument['nodes'] = [];
    const flush = (): void => {
      if (!slice.length) return;
      children.push({ ...node, id: `${node.id}:lift:${nextPartId()}`, children: slice });
      slice = [];
    };

    for (const child of node.children) {
      if (isInlineDocumentHost(child, hostData)) {
        flush();
        children.push(child);
        changed = true;
        continue;
      }
      const nested = liftInlineDocuments([child], hostData, nextPartId);
      if (nested.length !== 1 || nested[0] !== child) changed = true;
      slice.push(...nested);
    }
    flush();

    if (children.length === 1 && children[0] === node) result.push(node);
    else result.push(...children);
  }

  return changed ? result : nodes;
}

/**
 * 修正宿主节点调用形态并拆开块级子文档；无相关节点、且配置身份已清时原样返回同一份文档。
 *
 * 【为什么抹掉 `componentConfigKey`】聊天文档由**标准配置**的 `compileLocal` 编译，
 * 而这里用 `react/minimal` 渲染，两端配置键必然不同；上游 `LocalDocumentView` 会在
 * 键不一致时报 `local.extension.config-mismatch` 并降级。聊天的能力收缩由
 * `document-policy` 在编译后完成（只留 Markdown / 公式 / 适配器生成的宿主节点），
 * 所以渲染器装了哪些组件与文档无关，这个身份对聊天没有校验价值。
 *
 * ⚠️ 这等于**主动跳过**上游的「编译配置 / 渲染配置一致」护栏：若将来 policy 放开
 * 组件节点，必须改回携带真实配置身份（或让编译侧改用同一套 config），否则组件
 * 会按错误配置静默降级。
 */
export function normalizeChatRmdDocument(
  document: LocalDocument,
  hostData?: LocalHostData
): LocalDocument {
  const inlineNodes = normalizeHostForms(document.nodes);
  let part = 0;
  const liftedNodes = liftInlineDocuments(inlineNodes, hostData, () => {
    part += 1;
    return part;
  });
  // 无变化时保持输入身份：ChatRmdDocument 按文档身份重建 runtime，多造一个对象
  // 会在 hostData 换新引用时白重建一次。
  if (liftedNodes === document.nodes && document.componentConfigKey === undefined) return document;
  return { ...document, componentConfigKey: undefined, nodes: liftedNodes };
}

export interface ChatRmdDocumentProps {
  document: LocalDocument;
  hostData?: LocalHostData;
  hostRenderer?: LocalHostRenderer;
  urlPolicy?: LocalUrlPolicy;
}

interface RuntimeSlot {
  document: LocalDocument;
  runtime: LocalRuntime;
  mounted: boolean;
}

function createRuntimeSlot(document: LocalDocument): RuntimeSlot {
  return { document, runtime: createLocalRuntime(document), mounted: false };
}

export default function ChatRmdDocument({
  document,
  hostData,
  hostRenderer,
  urlPolicy,
}: ChatRmdDocumentProps) {
  const viewDocument = useMemo(
    () => normalizeChatRmdDocument(document, hostData),
    [document, hostData]
  );

  const [current, setCurrent] = useState(() => createRuntimeSlot(viewDocument));
  let active = current;
  if (current.document !== viewDocument) {
    active = createRuntimeSlot(viewDocument);
    setCurrent(active);
  }

  useEffect(() => {
    active.mounted = true;
    return () => {
      active.mounted = false;
      // StrictMode 会立即用同一个 runtime 重挂；先让微任务确认真的没人要了。
      queueMicrotask(() => {
        if (!active.mounted) active.runtime.dispose();
      });
    };
  }, [active]);

  return (
    <LocalDocumentView
      document={viewDocument}
      runtime={active.runtime}
      mode="static"
      capabilityGrants={CHAT_RMD_CAPABILITY_GRANTS}
      urlPolicy={urlPolicy}
      hostData={hostData}
      hostRenderer={hostRenderer}
      locale="zh"
    />
  );
}
