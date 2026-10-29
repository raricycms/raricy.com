'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { canEditQuoteSubmission, type QuoteSubmissionDraft } from '@/lib/daily-quote';
import DailyQuoteForm from './DailyQuoteForm';

export default function DailyQuoteSubmissionEditor({ submission, children, readOnly = false }: {
  submission: QuoteSubmissionDraft;
  children: ReactNode;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      button.current?.focus();
    }
  }, [editing]);

  function close() {
    restoreFocus.current = true;
    setEditing(false);
  }

  const editable = !readOnly && canEditQuoteSubmission(submission.status);
  if (editing && editable) return <DailyQuoteForm submission={submission}
    onCancel={close} onSaved={() => { setSaved(true); close(); }} />;

  return <>
    {children}
    {saved && <p className="daily-quote-card__hint" role="status">{submission.status === 'rejected'
      ? '修改已重新提交，等待管理员审核；原版本和审核意见已保留。' : '修改已保存，等待管理员审核。'}</p>}
    {editable && <button ref={button} type="button" className="daily-quote-secondary"
      onClick={() => { setSaved(false); setEditing(true); }}>编辑投稿</button>}
  </>;
}
