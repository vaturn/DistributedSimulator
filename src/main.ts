// 진입점: M0에서는 빈 캔버스에 배경만 칠한다.
// 엔진·감독관·렌더러 조립은 이후 마일스톤에서 추가한다.

/** 캔버스 요소의 id (index.html과 맞춘다) */
const CANVAS_ID = "sim-canvas";
/** 캔버스 배경색 */
const BACKGROUND_COLOR = "#1e1e24";
/** 캔버스 기본 크기(px) */
const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 600;

/** 캔버스 크기를 정하고 배경을 칠한다. */
function drawBackground(canvas: HTMLCanvasElement): void {
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D 컨텍스트를 얻을 수 없습니다.");
  }
  ctx.fillStyle = BACKGROUND_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

const canvas = document.getElementById(CANVAS_ID);
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error(`#${CANVAS_ID} 캔버스 요소를 찾을 수 없습니다.`);
}
drawBackground(canvas);
