'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatRmdDocument.tsx — 聊天静态 RMD 文档的内层渲染器（正文与子剪贴板共用）
//
// 聊天文档只交给上游 `LocalStaticDocumentView` 渲染：不创建 runtime、不持有编译
// 状态。文档必须带 `requiresRuntime: false`（`document-policy` 在编译结果上设置），
// 否则静态视图拒绝渲染并把整篇换成错误提示。
//
// 【配置身份必须对齐】聊天编译用 minimal preset 的 `config`（见 chat-rmd/options），
// 这里的 `createReactHost()` 也以 minimal preset 为基底，两端 `config.key` 相同；
// 静态视图会拿文档的 `componentConfigKey` 对账，不一致就报
// `local.extension.config-mismatch`。这是护栏：不要在视图层抹掉该字段来绕过。
//
// 【为什么在这里把 chat-ref 的 hostForm 改成 inline】引用适配器生成的是 inline
// 宿主节点 + 只有一个 `slot` 属性，更早的文档可能没有 `hostForm`；上游静态视图对
// 「没有 kind/ref 且不是 inline/container」的节点会直接渲染 `local-host-unavailable`
// 占位、**不调用** hostRenderer。聊天视图按 slot 从 hostData 取数据，本来就不走上游
// 的 kind:ref 查表，因此这里把 chat-ref 统一成 inline —— 只影响调用路径，不改节点
// 数据或预算。（适配器已生成 inline 时，这个归一化就是 no-op。）
//
// 【块级子文档】剪贴板子文档是 `<article>`（块级），留在 `<p>` 里是非法嵌套
// （React 会报 hydration 警告，浏览器解析与客户端 DOM 也会分叉）；`liftInlineDocuments`
// 只调整宿主节点的挂载层级，不改文字与顺序。
// ─────────────────────────────────────────────────────────────────────────────

import 'reactive-md/styles/minimal.css';

import { useMemo } from 'react';
import type { LocalDocument } from 'reactive-md';
import {
  LocalStaticDocumentView,
  type LocalHostData,
  type LocalHostRenderer,
} from 'reactive-md/react/static';
import { createReactHost, type LocalUrlPolicy } from 'reactive-md/react/minimal';
import { CHAT_REF_HOST_TAG, CHAT_REF_SLOT_ATTR, isChatHostData } from '@/lib/chat-rmd/reference-types';

/** 聊天静态挂载的能力上限：三项全关（编译期策略之外的挂载侧第二道闸）。 */
export const CHAT_RMD_CAPABILITY_GRANTS = Object.freeze({
  enableCss: false,
  enableJavaScript: false,
  enableExtendedHtml: false,
});

/**
 * 模块级单例：宿主实现与 reactConfig 只组装一次。
 *
 * `createReactHost()` 以 minimal React preset 为基底，与聊天编译的
 * `createLocalConfig({ presets: [minimalPreset] })` 得到同一个 `config.key`；
 * 静态视图用它校验文档的 `componentConfigKey`。
 */
const CHAT_RMD_REACT_HOST = createReactHost();
const CHAT_RMD_REACT_CONFIG = CHAT_RMD_REACT_HOST.reactConfig;

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
 * 修正宿主节点调用形态并拆开块级子文档；无相关节点时原样返回同一份文档。
 *
 * 不在这里改写 `componentConfigKey`：编译配置与静态视图的 `reactConfig` 使用同一套
 * minimal preset，配置身份必须留给上游做一致性校验 —— 不匹配要暴露成诊断，而不是
 * 跳过护栏后按错误配置静默降级。
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
  // 无变化时保持输入身份：静态视图按文档身份记忆渲染结果，多造对象只会白算一次。
  if (liftedNodes === document.nodes) return document;
  return { ...document, nodes: liftedNodes };
}

export interface ChatRmdDocumentProps {
  document: LocalDocument;
  hostData?: LocalHostData;
  hostRenderer?: LocalHostRenderer;
  urlPolicy?: LocalUrlPolicy;
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

  return (
    <LocalStaticDocumentView
      document={viewDocument}
      reactConfig={CHAT_RMD_REACT_CONFIG}
      capabilityGrants={CHAT_RMD_CAPABILITY_GRANTS}
      urlPolicy={urlPolicy}
      hostData={hostData}
      hostRenderer={hostRenderer}
      locale="zh"
    />
  );
}
