'use client';

import Link from 'next/link';
import { useEffect } from 'react';

export default function HexToolPage() {
  useEffect(() => {
    const fileInput = document.getElementById('fileInput') as HTMLInputElement;
    const btnDownload = document.getElementById('btnDownload') as HTMLButtonElement;
    const hexViewer = document.getElementById('hexViewer') as HTMLElement;
    const statusText = document.getElementById('statusText') as HTMLElement;
    const fileInfo = document.getElementById('fileInfo') as HTMLElement;
    const loadProgressGroup = document.getElementById('loadProgressGroup') as HTMLElement;
    const loadProgressBar = document.getElementById('loadProgressBar') as HTMLElement;
    const loadProgressText = document.getElementById('loadProgressText') as HTMLElement;
    const btnCancelLoad = document.getElementById('btnCancelLoad') as HTMLElement;

    let originalFileName = '';
    let fileBytes = new Uint8Array();
    let modifiedIndices = new Set<number>();

    function showStatus(msg: string) {
      statusText.textContent = msg;
    }

    function hexByte(n: number) {
      return n.toString(16).toUpperCase().padStart(2, '0');
    }

    function refreshAll() {
      renderViewer(fileBytes);
      btnDownload.disabled = fileBytes.length === 0;
      fileInfo.textContent = `${fileBytes.length} 字节`;
    }

    // Virtualized rendering with larger initial window
    function renderViewer(bytes: Uint8Array) {
      const bodyEl = document.getElementById('hexBody');
      if (!bodyEl) return;
      const rowHeight = 24; // slightly smaller to fit more per viewport
      const viewport = hexViewer.getBoundingClientRect();
      const scrollTop = hexViewer.scrollTop;
      const total = bytes.length;
      const rows = Math.ceil(total / 16);
      const isInitial = bodyEl.childElementCount === 0 && scrollTop === 0;
      const preBuffer = isInitial ? 100 : 30; // render more at top initially
      const postBuffer = isInitial ? 200 : 50; // render more at bottom initially
      const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - preBuffer);
      const endRow = Math.min(rows, Math.ceil((scrollTop + viewport.height) / rowHeight) + postBuffer);

      // paddings to keep scroll height
      const topPad = startRow * rowHeight;
      const bottomPad = (rows - endRow) * rowHeight;

      const lines: string[] = [];
      lines.push(`<div class="pad" style="height:${topPad}px"></div>`);
      for (let r = startRow; r < endRow; r++) {
        const start = r * 16;
        const end = Math.min(start + 16, total);
        const offsetLabel = (r * 16).toString(16).toUpperCase().padStart(8, '0');
        let hexCells = '';
        let asciiCells = '';
        for (let i = start; i < end; i++) {
          const val = bytes[i];
          const hx = hexByte(val);
          const isGroupGap = (i % 16) === 7; // after 8th byte add larger gap
          const modifiedClass = modifiedIndices.has(i) ? ' modified-cell' : '';
          hexCells += `<span class="byte${isGroupGap ? ' group-gap' : ''}${modifiedClass}" data-index="${i}" tabindex="0">${hx}</span>`;
          const ch = (val >= 0x20 && val <= 0x7e) ? String.fromCharCode(val) : '.';
          asciiCells += `<span class="char${modifiedClass}" data-index="${i}" tabindex="0">${ch}</span>`;
        }
        // pad remaining cells to 16 for layout alignment
        for (let i = end; i < start + 16; i++) {
          const isGroupGap = (i % 16) === 7;
          hexCells += `<span class="byte${isGroupGap ? ' group-gap' : ''}" style="opacity:.2">  </span>`;
          asciiCells += `<span class="char" style="opacity:.2"> </span>`;
        }
        lines.push(`<div class="hex-line" style="height:${rowHeight}px"><div class="hex-offset">${offsetLabel}</div><div class="hex-bytes">${hexCells}</div><div class="hex-ascii">${asciiCells}</div></div>`);
      }
      lines.push(`<div class="pad" style="height:${bottomPad}px"></div>`);
      bodyEl.innerHTML = lines.join('');
    }

    let currentAbort: AbortController | null = null;
    function resetProgress() {
      loadProgressBar.style.width = '0%';
      loadProgressText.textContent = '0%';
    }
    function showProgressUI(show: boolean) {
      loadProgressGroup.style.display = show ? '' : 'none';
      btnCancelLoad.style.display = show ? '' : 'none';
    }

    function onCancelLoad() {
      if (currentAbort) currentAbort.abort();
      showProgressUI(false);
      showStatus('已取消加载');
    }
    btnCancelLoad.addEventListener('click', onCancelLoad);

    async function onFileChange() {
      const f = fileInput.files?.[0];
      if (!f) return;
      originalFileName = f.name || 'modified.bin';
      modifiedIndices = new Set<number>();
      showProgressUI(true);
      resetProgress();

      // Stream read for progress using fetch on blob URL
      const url = URL.createObjectURL(f);
      const controller = new AbortController();
      currentAbort = controller;
      try {
        const resp = await fetch(url, { signal: controller.signal });
        const reader = resp.body!.getReader();
        const total = f.size;
        let received = 0;
        const chunks: BlobPart[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          const percent = Math.min(100, Math.floor((received / total) * 100));
          loadProgressBar.style.width = percent + '%';
          loadProgressText.textContent = percent + '%';
        }
        const blob = new Blob(chunks, { type: 'application/octet-stream' });
        const buf = await blob.arrayBuffer();
        fileBytes = new Uint8Array(buf);
        refreshAll();
        showStatus('加载完成');
      } catch {
        if (controller.signal.aborted) {
          // keep current state
        } else {
          showStatus('加载失败');
        }
      } finally {
        showProgressUI(false);
        URL.revokeObjectURL(url);
        currentAbort = null;
      }
    }
    fileInput.addEventListener('change', onFileChange);

    function onDownload() {
      try {
        const blob = new Blob([fileBytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const dot = originalFileName.lastIndexOf('.');
        const name = dot > 0 ? `${originalFileName.slice(0, dot)}.modified${originalFileName.slice(dot)}` : `${originalFileName}.modified`;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showStatus('已下载');
      } catch (e) {
        showStatus('下载失败：' + ((e as Error).message || ''));
      }
    }
    btnDownload.addEventListener('click', onDownload);

    // Cross highlight
    function clearActive() {
      hexViewer.querySelectorAll('.active-cell').forEach((e) => e.classList.remove('active-cell'));
    }
    function onMouseOver(e: Event) {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const idx = t.getAttribute('data-index');
      if (!idx) return;
      clearActive();
      hexViewer.querySelectorAll(`[data-index="${idx}"]`).forEach((el) => el.classList.add('active-cell'));
    }
    hexViewer.addEventListener('mouseover', onMouseOver);
    function onFocusIn(e: Event) {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const idx = t.getAttribute('data-index');
      if (!idx) return;
      clearActive();
      hexViewer.querySelectorAll(`[data-index="${idx}"]`).forEach((el) => el.classList.add('active-cell'));
    }
    hexViewer.addEventListener('focusin', onFocusIn);
    hexViewer.addEventListener('mouseleave', clearActive);

    // Inline edit on double click
    function beginEditHexCell(span: HTMLElement) {
      const idx = Number(span.getAttribute('data-index'));
      const oldText = (span.textContent || '').trim();
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 2;
      input.value = oldText;
      input.className = 'form-control form-control-sm mono';
      input.style.width = '48px';
      input.style.display = 'inline-block';
      input.style.padding = '0 4px';
      input.style.height = '24px';
      span.replaceWith(input);
      input.focus();
      input.select();

      function commit() {
        const val = (input.value || '').trim();
        if (val === '') {
          // delete byte at idx
          const arr = Array.from(fileBytes);
          arr.splice(idx, 1);
          fileBytes = new Uint8Array(arr);
          // shift modified indices
          const newSet = new Set<number>();
          modifiedIndices.forEach((j) => {
            if (j < idx) newSet.add(j);
            else if (j > idx) newSet.add(j - 1);
          });
          modifiedIndices = newSet;
          showStatus(`已删除索引 ${idx} 字节`);
          refreshAll();
          return;
        }
        const hex = val.toUpperCase();
        if (!/^[0-9A-F]{1,2}$/.test(hex)) {
          showStatus('请输入 1-2 位十六进制');
          input.focus();
          input.select();
          return;
        }
        const byte = parseInt(hex, 16);
        if (Number.isNaN(byte)) {
          showStatus('非法十六进制');
          input.focus();
          input.select();
          return;
        }
        if (fileBytes[idx] !== byte) {
          fileBytes[idx] = byte;
          modifiedIndices.add(idx);
        }
        showStatus('已更新');
        refreshAll();
      }
      function cancel() {
        refreshAll();
      }

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          commit();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
        if (e.key === 'Backspace' && input.value.length === 0) {
          e.preventDefault();
          commit();
        }
      });
      input.addEventListener('blur', commit);
    }

    function onDblClick(e: Event) {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (t.classList.contains('byte') && t.hasAttribute('data-index')) {
        beginEditHexCell(t);
      }
    }
    hexViewer.addEventListener('dblclick', onDblClick);

    // Virtual scrolling: re-render on scroll
    function onScroll() {
      renderViewer(fileBytes);
    }
    hexViewer.addEventListener('scroll', onScroll);

    return () => {
      btnCancelLoad.removeEventListener('click', onCancelLoad);
      fileInput.removeEventListener('change', onFileChange);
      btnDownload.removeEventListener('click', onDownload);
      hexViewer.removeEventListener('mouseover', onMouseOver);
      hexViewer.removeEventListener('focusin', onFocusIn);
      hexViewer.removeEventListener('mouseleave', clearActive);
      hexViewer.removeEventListener('dblclick', onDblClick);
      hexViewer.removeEventListener('scroll', onScroll);
    };
  }, []);

  return (
    <section className="py-4 base-tool-page">
      <div className="container">
        <div className="d-flex align-items-center mb-3">
          <Link href="/tool" className="text-decoration-none me-2">←</Link>
          <h1 className="mb-0 tool-new-hero__title">Hex 查看 / 编辑</h1>
        </div>
        <p className="tool-new-hero__description">在浏览器中完成：文件 → Hex 查看与编辑 → 下载为修改后的文件。</p>

        <div className="p-3 rounded tool-panel mb-4">
          <div className="row g-3 align-items-center">
            <div className="col-12 col-md-6">
              <label htmlFor="fileInput" className="form-label fw-semibold">选择文件</label>
              <input id="fileInput" className="form-control" type="file" />
              <div className="form-text">支持任意类型文件，大小受浏览器可用内存限制。</div>
            </div>
            <div className="col-12 col-md-6 d-flex gap-2 flex-wrap align-items-center">
              <div id="loadProgressGroup" className="flex-grow-1" style={{ display: 'none', minWidth: '240px' }}>
                <div className="progress" role="progressbar" aria-label="文件加载进度" aria-valuemin={0} aria-valuemax={100}>
                  <div id="loadProgressBar" className="progress-bar progress-bar-striped progress-bar-animated" style={{ width: '0%' }}></div>
                </div>
                <small id="loadProgressText" className="text-muted">0%</small>
              </div>
              <button id="btnCancelLoad" className="btn btn-outline-danger" style={{ display: 'none' }}> 取消加载</button>
              <button id="btnDownload" className="btn btn-primary" disabled> 下载修改后的文件</button>
              <span id="fileInfo" className="ms-auto text-muted form-hint"></span>
            </div>
          </div>
        </div>

        <div className="hex-grid">
          <div className="p-3 rounded viewer-panel">
            <div className="d-flex justify-content-between align-items-center mb-2">
              <label className="form-label fw-semibold mb-0">Hex 视图</label>
              <small className="text-muted">三列：偏移地址、Hex 值、ASCII 字符</small>
            </div>
            <div id="hexViewer" className="hex-viewer mono">
              <div className="hex-header hex-line">
                <div className="hex-offset">偏移</div>
                <div className="hex-bytes">
                  <span className="byte">00</span><span className="byte">01</span><span className="byte">02</span><span className="byte">03</span><span className="byte">04</span><span className="byte">05</span><span className="byte">06</span><span className="byte group-gap">07</span><span className="byte">08</span><span className="byte">09</span><span className="byte">0A</span><span className="byte">0B</span><span className="byte">0C</span><span className="byte">0D</span><span className="byte">0E</span><span className="byte">0F</span>
                </div>
                <div className="hex-ascii">ASCII</div>
              </div>
              <div id="hexBody" className="hex-body"></div>
            </div>
            <div className="d-flex justify-content-between mt-2">
              <small className="text-muted">提示：双击 Hex 可编辑或删除；修改项将高亮</small>
              <span id="statusText" className="text-muted"></span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
