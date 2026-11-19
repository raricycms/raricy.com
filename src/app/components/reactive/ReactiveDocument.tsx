'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
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

  const [zoom, setZoom] = useState<ImageZoomSource | null>(null);
  /** 放着大的那张原图：临时隐藏它，关掉时还原并接回焦点（见 closeZoom）。 */
  const zoomedImage = useRef<HTMLImageElement | null>(null);

  // 正文里的配图：拦下上游自带的「原生 <dialog> 预览」，改成原位放大（见 ImageZoom）。
  // 用捕获阶段：图片自己（或包着它的按钮）上的处理器要先被挡住，否则两套查看器会同时开。
  // 判据必须与上游一致 —— 图套在链接里、或在编辑器预览里时不接管，交给上游与链接本身。
  const zoomableImage = useCallback((target: EventTarget | null): HTMLImageElement | null => {
    if (role !== 'read' || zoom) return null;
    const image = target instanceof Element ? target.closest('img.md-image') : null;
    if (!(image instanceof HTMLImageElement)) return null;
    if (image.closest('a')) return null;
    return image;
  }, [role, zoom]);

  const openZoom = useCallback((image: HTMLImageElement, rect: DOMRect) => {
    image.style.visibility = 'hidden';
    zoomedImage.current = image;
    setZoom({
      image,
      src: image.currentSrc || image.src,
      alt: image.alt,
      naturalWidth: image.naturalWidth || Math.round(rect.width),
      naturalHeight: image.naturalHeight || Math.round(rect.height),
    });
  }, []);

  /**
   * 同一张图有三个入口（指针点击、键盘 Enter / Space、上游自己的按钮态），这里统一成
   * 一个判据：命中就把这次交互交给自己，不命中才让上游照旧处理。
   *
   * 表情、图标一类的小图不放大（它们不是「看清楚」的对象），但也要把交互拦住 ——
   * 否则会掉回上游的 `<dialog>` 预览，「小图不放大」就只是换了个查看器。
   */
  const takeImage = useCallback((target: EventTarget | null, event: { preventDefault(): void; stopPropagation(): void }) => {
    const image = zoomableImage(target);
    if (!image) return;
    const rect = image.getBoundingClientRect();
    event.preventDefault();
    event.stopPropagation();
    if (rect.width < 32 || rect.height < 32) return;
    openZoom(image, rect);
  }, [zoomableImage, openZoom]);

  const onContentClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    takeImage(event.target, event);
  }, [takeImage]);

  const onContentKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    // 上游把图片渲染成 role="button" 并接受 Enter / Space；不拦这一下，键盘会打开
    // 另一套（原生 dialog）查看器，与指针路径分裂。
    if (event.key !== 'Enter' && event.key !== ' ') return;
    takeImage(event.target, event);
  }, [takeImage]);

  const closeZoom = useCallback(() => {
    const image = zoomedImage.current;
    zoomedImage.current = null;
    if (image) {
      image.style.visibility = '';
      // 关掉之后焦点回到正文里那张图：键盘用户不会掉回 body。
      if (image.isConnected) image.focus({ preventScroll: true });
    }
    setZoom(null);
  }, []);

  // 导航离开时已经没有人等这次放大：把临时藏起来的图还原，免得同一个节点被复用后仍是隐藏的。
  useEffect(() => () => {
    if (zoomedImage.current) zoomedImage.current.style.visibility = '';
  }, []);

  return (
    <div
      className="reactive-document"
      data-content-renderer={role}
      onClickCapture={onContentClick}
      onKeyDownCapture={onContentKeyDown}
    >
      <CompiledDocumentView {...props} hostRenderer={hostRenderer} />
      {zoom && <ImageZoom source={zoom} onDone={closeZoom} />}
    </div>
  );
}
