// Cards as plain text for channels that can't show buttons. The number a person answers with is the card id —
// kept exactly, options listed 1-based so "10" means the tenth.
type CardView = {
  id: number;
  kind: string;
  title: string;
  text?: string | null;
  detail?: string | null;
  options?: string[];
  recommend?: number | null;
  state?: string;
  choice?: number | null;
  answer?: string | null;
};

export function renderCardText(card: CardView): string {
  // A closed notice (fyi push, already-settled update) is information, not a question: show its content as-is.
  if (card.state && card.state !== "open") {
    const lines = [`【${card.title}】`, card.text ?? ""];
    if (card.state === "decided") {
      const picked =
        card.choice !== null && card.choice !== undefined ? `第 ${card.choice + 1} 项` : (card.answer ?? "");
      lines.push(`#${card.id} 已定：${picked}`);
    }
    return lines.filter(Boolean).join("\n");
  }
  const lines = [`【${card.title}】`, card.text ?? ""];
  if (card.kind === "notice") {
    lines.push(`回复 #${card.id} 确认 标记已处理`);
  } else {
    (card.options ?? []).forEach((option, i) => lines.push(`${i + 1}. ${option}`));
    const hint =
      card.recommend !== null && card.recommend !== undefined ? `（「确认」= 第 ${card.recommend + 1} 项）` : "";
    lines.push(`回复 #${card.id} <序号> 或一句话${hint}`);
  }
  return lines.filter(Boolean).join("\n");
}
