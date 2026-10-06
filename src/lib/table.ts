import type { ClipboardEvent } from "react";

// 엑셀·스프레드시트에서 복사한 칸은 탭으로 구분된 글로 온다. 줄바꿈·탭이 든 칸은 큰따옴표로 감싸고 안쪽 따옴표를 두 번 쓴다.
const QUOTED = /"((?:[^"]|"")*)"(?=[\t\n]|$)/y;
const PLAIN = /[^\t\n]*/y;

function parseCells(text: string): string[][] {
  const s = text.replace(/\r\n?/g, "\n");
  const rows: string[][] = [[]];
  for (let i = 0; i <= s.length; i++) {
    QUOTED.lastIndex = PLAIN.lastIndex = i;
    const quoted = s[i] === '"' ? QUOTED.exec(s) : null;
    const cell = quoted ? quoted[1].replace(/""/g, '"') : PLAIN.exec(s)![0];
    i += quoted ? quoted[0].length : cell.length;
    rows[rows.length - 1].push(cell);
    if (s[i] === "\n") rows.push([]);
  }
  return rows;
}

// 복사한 표를 줄마다 '열 이름: 값'인 글로 바꾼다(첫 줄 = 열 이름, 빈칸은 뺀다). 표가 아니면 null.
// 자료는 AI에 JSON 문자열로 전달되므로, 탭으로 나뉜 표보다 값마다 이름이 붙은 글이 다른 열로 잘못 읽힐 여지가 적다.
export function tableToText(clip: string): string | null {
  const rows = parseCells(clip)
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some(Boolean));
  const [header, ...body] = rows;
  // 표로 보는 기준: 열 이름이 2개 이상이고, 내용이 1줄 이상이며, 모든 줄의 칸 수가 같다(엑셀은 늘 네모로 복사한다).
  if (!header || !body.length || header.filter(Boolean).length < 2 || rows.some((r) => r.length !== header.length)) return null;
  return body
    .map((r, n) => [`[${n + 1}]`, ...r.flatMap((c, i) => (c ? [`- ${header[i] || `열 ${i + 1}`}: ${c.replace(/\s*\n\s*/g, " / ")}`] : []))].join("\n"))
    .join("\n\n");
}

// 자료 칸의 붙여넣기: 표면 바꾼 글을 커서 자리에 넣고, 표가 아니면 브라우저 기본 동작에 맡긴다.
export function pasteTable(e: ClipboardEvent<HTMLTextAreaElement>, set: (value: string) => void) {
  const text = tableToText(e.clipboardData.getData("text/plain"));
  if (!text) return;
  e.preventDefault();
  const el = e.currentTarget;
  set(el.value.slice(0, el.selectionStart) + text + el.value.slice(el.selectionEnd));
}
