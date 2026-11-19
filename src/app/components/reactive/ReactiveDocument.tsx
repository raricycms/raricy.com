'use client';

import { useCallback, useState, type MouseEvent } from 'react';
import type { LocalDocumentViewProps, LocalHostRenderer } from 'reactive-md/react/unstyled';
import CompiledDocumentView from './CompiledDocumentView';
import { SiteEmbedView } from './SiteEmbedView';
import ImageZoom, { type ImageZoomSource } from './ImageZoom';

interface ReactiveDocumentProps extends Pick<
  LocalDocumentViewProps, 'document' | 'hostData' | 'mode' | 'staticFirst' | 'locale'
> {
  preview?: boolean;
  role?: 'read' | 'preview';
}

export default function ReactiveDocument({
  preview = false,
  role = 'read',
  ...props
}: ReactiveDocumentProps) {
  const hostRenderer = useCallback<LocalHostRenderer>(
    (node, data, context) => SiteEmbedView(node, data, context, { preview }),
    [preview]
  );

  const [zoom, setZoom] = useState<{ source: ImageZoomSource } | null>(null);

  // 正文里的配图：拦下上游自带的「原生 <dialog> 预览」，改成原位放大（见 ImageZoom）。
  // 用捕获阶段：图片自己（或包着它的按钮）上的点击处理器要先被挡住，否则两套查看器会同时开。
  const onContentClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (role !== 'read' || zoom) return;
    const target = event.target instanceof Element ? event.target.closest('img.md-image') : null;
    if (!(target instanceof HTMLImageElement)) return;
    const rect = target.getBoundingClientRect();
    // 表情、图标一类的小图不放大：它们不是「看清楚」的对象。
    if (rect.width < 32 || rect.height < 32) return;
    event.preventDefault();
    event.stopPropagation();
    target.style.visibility = 'hidden';
    setZoom({
      source: {
        image: target,
        src: target.currentSrc || target.src,
        alt: target.alt,
        naturalWidth: target.naturalWidth || Math.round(rect.width),
        naturalHeight: target.naturalHeight || Math.round(rect.height),
      },
    });
  }, [role, zoom]);

  const finishZoom = useCallback(() => {
    setZoom((current) => {
      if (current) current.source.image.style.visibility = '';
      return null;
    });
  }, []);

  return (
    <div
      className="reactive-document"
      data-content-renderer={role}
      onClickCapture={onContentClick}
    >
      <CompiledDocumentView {...props} hostRenderer={hostRenderer} />
      {zoom && <ImageZoom source={zoom.source} onDone={finishZoom} />}
    </div>
  );
}
