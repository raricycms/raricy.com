'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, HelpCircle, Play, Square, Undo2, X } from 'lucide-react';
import { Drawing, Rune, YiwenIcon } from './art';
import { equal, MAX_PROGRAM, run, type Figure, type Instruction } from './engine';
import { EXPERIMENTS, INSCRIPTION, INSCRIPTION_INPUT, INSCRIPTION_TARGET } from './levels';
import { freshProgress, readProgress, SAVE_KEY } from './progress';

const runeName = (op: Instruction) => `${op.framed ? '带框的' : ''}${op.rune === 'turn' ? '甲' : '乙'}`;

export default function Yiwen() {
  const [progress, setProgress] = useState(freshProgress);
  const [ready, setReady] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [framed, setFramed] = useState(false);
  const [trace, setTrace] = useState<Figure[] | null>(null);
  const [step, setStep] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [plateFeedback, setPlateFeedback] = useState('');
  const [matched, setMatched] = useState(false);
  const [hints, setHints] = useState(0);
  const [previous, setPrevious] = useState<Figure | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const plateRef = useRef<HTMLElement>(null);

  useEffect(() => {
    try { setProgress(readProgress(localStorage.getItem(SAVE_KEY))); }
    catch { setStorageUnavailable(true); }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(progress)); }
    catch { setStorageUnavailable(true); }
  }, [progress, ready]);

  const level = EXPERIMENTS.find((item) => item.id === progress.selected);
  const input = level?.input ?? INSCRIPTION_INPUT;
  const program = progress.drafts[progress.selected] ?? [];
  const output = trace?.[step] ?? input;
  const extent = Math.max(2, input.width, input.height, output.width, output.height, level?.target.width ?? 0, level?.target.height ?? 0);
  const allDone = progress.completed.length === EXPERIMENTS.length;

  function select(id: string) {
    setProgress((p) => ({ ...p, selected: id }));
    setTrace(null); setStep(0); setMatched(false); setFeedback(''); setPlateFeedback(''); setHints(0); setPrevious(null);
    titleRef.current?.focus({ preventScroll: true });
  }

  function edit(next: Instruction[]) {
    if (trace) setPrevious(trace[trace.length - 1]);
    setProgress((p) => ({ ...p, drafts: { ...p.drafts, [p.selected]: next } }));
    setTrace(null); setStep(0); setMatched(false);
    setFeedback('句子已变更，运行查看结果。');
  }

  function execute() {
    const result = run(input, program);
    setTrace(result.frames); setStep(result.frames.length - 1);
    const solved = !result.error && !!level && equal(result.frames[result.frames.length - 1], level.target);
    setMatched(solved);
    setFeedback(result.error ?? (solved ? '最终输出与对照一致。' : level ? '拓印完成。可以继续改写，也可以点轨迹查看每一步。' : '拓印完成，可以放入铭牌试试。'));
    if (solved && level) setProgress((p) => ({ ...p, completed: [...new Set([...p.completed, level.id])] }));
  }

  function submitPlate() {
    if (!trace) { setFeedback('先运行句子，得到一张拓印。'); return; }
    if (equal(output, INSCRIPTION_TARGET)) {
      setProgress((p) => ({ ...p, opened: true }));
      setFeedback('铭牌打开了。');
      setPlateFeedback('');
    } else {
      setFeedback('这张拓印没有让铭牌产生变化。');
      setPlateFeedback('这张拓印没有让铭牌产生变化。');
    }
  }

  return <div className="container yw-game" data-ready={ready}>
    <header className="yw-header">
      <div className="yw-heading">
        <Link href="/game/collections/test" className="yw-icon-button" aria-label="返回玩具测试合集"><ArrowLeft size={20} /></Link>
        <span className="yw-logo"><YiwenIcon /></span>
        <h1>异文 <small>Demo</small></h1>
      </div>
      <span className="yw-progress"><span className="numeric">{progress.completed.length} / {EXPERIMENTS.length}</span> 张已复原</span>
    </header>

    <nav className="yw-cards" aria-label="实验卡">
      {EXPERIMENTS.map((item) => <button key={item.id} type="button" className={`yw-card-tab ${progress.selected === item.id ? 'is-active' : ''}`}
        aria-pressed={progress.selected === item.id} aria-label={`实验 ${item.id} ${item.name}${progress.completed.includes(item.id) ? '，已复原' : ''}`}
        onClick={() => select(item.id)} disabled={!ready}>
        <span className="numeric">{item.id}</span><span>{item.name}</span>{progress.completed.includes(item.id) && <Check size={14} />}
      </button>)}
    </nav>

    <div className="yw-layout">
      <section className="yw-workbench" aria-label="异文实验台" data-experiment={progress.selected} data-matched={matched}>
        <div className="yw-bench-heading">
          <div><p className="yw-eyebrow">{level ? `实验卡 ${level.id}` : '铭牌底稿'}</p><h2 tabIndex={-1} ref={titleRef}>{level?.name ?? '未写完的一句'}</h2></div>
          {level && <button className="yw-secondary" type="button" onClick={() => setHints((n) => Math.min(2, n + 1))} disabled={hints === 2}>
            <HelpCircle size={17} />{hints ? '再给一点提示' : '一点提示'}
          </button>}
        </div>

        <div className="yw-papers">
          <figure><figcaption>底稿</figcaption><Drawing value={input} label="底稿" extent={extent} /></figure>
          <figure className="yw-output"><figcaption>{trace ? `输出 · 第 ${step} 步` : '输出 · 待运行'}</figcaption><Drawing value={output} label="当前输出" extent={extent} /></figure>
          <figure><figcaption>{level ? '对照' : '铭牌'}</figcaption>{level ? <Drawing value={level.target} label="对照" extent={extent} /> :
            <div className="yw-unknown"><span aria-hidden="true">?</span><p>查看门侧的刻痕</p></div>}</figure>
        </div>
        <p className="yw-paper-note">虚线是纸张边界，小点标出格心。</p>

        <section className="yw-editor" aria-label="编写句子">
          <div className="yw-editor-heading"><h3>句子</h3><span><span className="numeric">{program.length} / {MAX_PROGRAM}</span> 枚</span></div>
          <div className="yw-program" aria-label="当前句子">
            {program.length === 0 && <span className="yw-empty">从下面选一枚符号</span>}
            {program.map((op, i) => <button className="yw-token" type="button" key={i} aria-label={`移除第 ${i + 1} 枚${runeName(op)}`} title="点击移除" onClick={() => edit(program.filter((_, index) => index !== i))}>
              <Rune {...op} /><span className="numeric">{i + 1}</span>
            </button>)}
          </div>
          <div className="yw-palette">
            {(['turn', 'copy'] as const).map((rune) => <button className="yw-rune-button" key={rune} type="button" disabled={!ready || program.length >= MAX_PROGRAM}
              aria-label={`加入${runeName({ rune, framed })}`} onClick={() => edit([...program, { rune, framed }])}>
              <Rune rune={rune} framed={framed} /><span>{rune === 'turn' ? '甲' : '乙'}</span>
            </button>)}
            <button type="button" className={`yw-frame-button ${framed ? 'is-active' : ''}`} aria-pressed={framed} onClick={() => setFramed(!framed)}>
              <Square size={18} />加框
            </button>
          </div>
          <p className="yw-instruction">点击符号加入句子，从左到右运行。点击句中的符号可移除。“加框”用于接下来加入的符号。</p>
          <div className="yw-toolbar">
            <button type="button" className="yw-primary" disabled={!ready || !program.length} onClick={execute}><Play size={17} />运行句子</button>
            <button type="button" className="yw-secondary" disabled={!program.length} onClick={() => edit(program.slice(0, -1))}><Undo2 size={17} />退一枚</button>
            <button type="button" className="yw-secondary" disabled={!program.length} onClick={() => edit([])}><X size={17} />清空</button>
          </div>
        </section>

        {trace && <div className="yw-trace" aria-label="执行轨迹"><span>查看每一步</span>{trace.map((_, i) =>
          <button key={i} type="button" className={`yw-step ${step === i ? 'is-active' : ''}`} aria-pressed={step === i} onClick={() => setStep(i)} aria-label={`查看第 ${i} 步`}>
            {i === 0 ? <span>底稿</span> : <><span className="numeric">{i}</span><Rune {...program[i - 1]} /></>}
          </button>)}
        </div>}

        <div className={`yw-feedback ${matched ? 'yw-feedback--success' : ''}`} role="status">
          <span>{matched && <Check size={18} />}{feedback || (level ? '让输出与对照一致。可以反复试验，没有步数评分。' : '底稿已放到实验台。')}</span>
          {matched && level && <button className="yw-primary" type="button" onClick={() => {
            const next = EXPERIMENTS[EXPERIMENTS.indexOf(level) + 1];
            if (next) select(next.id);
            else { plateRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' }); plateRef.current?.focus({ preventScroll: true }); }
          }}>{level.id === '07' ? '查看铭牌' : '下一张'}<ArrowRight size={16} /></button>}
        </div>
        {hints > 0 && level && <div className="yw-hint">{level.hints.slice(0, hints).map((hint) => <p key={hint}>{hint}</p>)}</div>}
      </section>

      <aside className="yw-sidebar">
        <section className="yw-plate" ref={plateRef} tabIndex={-1} aria-labelledby="yw-plate-title" data-opened={progress.opened}>
          <div className="yw-plate-heading"><h2 id="yw-plate-title">门侧铭牌</h2>{progress.opened && <Check size={18} />}</div>
          <div className="yw-inscription" role="img" aria-label={`从左到右的刻痕：${INSCRIPTION.map(runeName).join('、')}`}>
            {INSCRIPTION.map((op, i) => <Rune key={i} {...op} />)}
          </div>
          <div className="yw-plate-paper"><Drawing value={INSCRIPTION_INPUT} label="铭牌旧底稿" extent={3} /></div>
          <div className="yw-plate-actions">
            <button type="button" className="yw-secondary" disabled={!ready} onClick={() => {
              select('plate'); setFramed(false);
              titleRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
            }}>取下底稿<ArrowRight size={16} /></button>
            <button type="button" className="yw-primary" disabled={!trace} onClick={submitPlate}>放入当前拓印</button>
          </div>
          {plateFeedback && <p className="yw-plate-feedback" role="status">{plateFeedback}</p>}
          {progress.opened && <div className="yw-reveal" role="status"><h3>你读懂了这句话。</h3><p>铭牌上的刻痕和实验台的符号，使用同一套规则。底稿、句子、拓印，组成了一次完整的表达。</p><p>Demo 到这里结束。仍可自由改写、查看每一步。</p></div>}
        </section>
        <section className="yw-notebook" aria-label="实验说明">
          <h2>{allDone ? '七张实验卡已完成' : '自由试验'}</h2>
          <p>{allDone ? '还可以回到任意实验卡，尝试不同的写法。门侧的铭牌从一开始就可以使用。' : '所有实验卡都可以直接打开。当前句子与完成记录保存在这个浏览器里。'}</p>
          <p>甲、乙、加框始终可用。提示由你决定何时查看。</p>
          {storageUnavailable && <p className="yw-save-note" role="status">浏览器未允许保存；本次仍可正常游玩。</p>}
        </section>
        {previous && <section className="yw-previous"><h2>上次拓印</h2><Drawing value={previous} label="上次拓印" /></section>}
      </aside>
    </div>
  </div>;
}
