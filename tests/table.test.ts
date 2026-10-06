// 엑셀에서 복사한 표를 자료 글로 바꾸는 규칙
import { describe, expect, it } from "vitest";
import { tableToText } from "@/lib/table";

describe("엑셀 표 붙여넣기", () => {
  it("첫 줄을 열 이름으로 써서 줄마다 '열 이름: 값'으로 바꾸고 빈칸은 뺀다", () => {
    const clip = "사례명\t기간\t실제 인원(명)\t만족도\r\n2025 신입 교육\t2025-03-10~03-11\t112\t4.3/5\r\n2024 신입 교육\t\t143\t\r\n";
    expect(tableToText(clip)).toBe(
      ["[1]", "- 사례명: 2025 신입 교육", "- 기간: 2025-03-10~03-11", "- 실제 인원(명): 112", "- 만족도: 4.3/5", "", "[2]", "- 사례명: 2024 신입 교육", "- 실제 인원(명): 143"].join("\n"),
    );
  });

  it("칸 안의 줄바꿈·탭·따옴표(엑셀이 큰따옴표로 감싼 칸)를 한 칸으로 읽는다", () => {
    const clip = '사례명\t생긴 문제\n"2025 ""파일럿"""\t"계정 발급 지연\n강의장\t변경"\n';
    expect(tableToText(clip)).toBe(['[1]', '- 사례명: 2025 "파일럿"', "- 생긴 문제: 계정 발급 지연 / 강의장\t변경"].join("\n"));
  });

  it("따옴표로 시작하지만 감싼 칸이 아니면 글자 그대로 둔다", () => {
    expect(tableToText('이름\t의견\n가\t"좋음" 다수\n')).toBe(["[1]", "- 이름: 가", '- 의견: "좋음" 다수'].join("\n"));
  });

  it("이름 없는 열은 '열 n'으로 부르고, 빈 줄은 건너뛴다", () => {
    expect(tableToText("사례명\t\t비고\n가\t나\t다\n\t\t\n라\t\t마\n")).toBe(["[1]", "- 사례명: 가", "- 열 2: 나", "- 비고: 다", "", "[2]", "- 사례명: 라", "- 비고: 마"].join("\n"));
  });

  it("표가 아닌 글은 바꾸지 않는다", () => {
    expect(tableToText("")).toBeNull();
    expect(tableToText("그냥 한 줄")).toBeNull();
    expect(tableToText("여러 줄\n보통 글")).toBeNull(); // 한 열짜리
    expect(tableToText("열 이름만\t있고\t내용 없음")).toBeNull();
    expect(tableToText("제목\t부제\n탭이 없는 다음 줄")).toBeNull(); // 줄마다 칸 수가 다름
  });
});
