// 렌더러 공용 상수: 색, 크기, 여백, 글꼴. 렌더러의 매직 넘버는 이 파일에만 둔다.

/** 결과 종류에 차례로 배정하는 팔레트 (시나리오 결과 종류 순서의 인덱스로 고른다) */
export const RESULT_PALETTE: readonly string[] = [
  "#4e79a7",
  "#f28e2b",
  "#59a14f",
  "#e15759",
  "#b07aa1",
  "#edc948",
  "#76b7b2",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
];

/** 팔레트에 없는(시나리오에서 모은 목록 밖의) 결과 종류에 쓰는 색 */
export const UNKNOWN_RESULT_COLOR = "#888888";

export const COLORS = {
  background: "#1e1e24",
  text: "#e8e8ee",
  textDim: "#9a9aa8",
  poolFill: "#26262e",
  poolBorder: "#3a3a46",
  moduleFill: "#2a2a33",
  slotEmpty: "#4a4a58",
  /** 아직 얻지 못한 파이 조각의 바탕 */
  sliceEmptyFill: "#1e1e24",
  jobOutline: "#d0d0da",
  progressTrack: "#3a3a46",
  progressBar: "#ffffff",
  /** DONE_AT_MODULE(처리 끝, 감독관이 옮기길 기다림) 표시 */
  doneMarker: "#ffd166",
  ended: "#ff6b6b",
  /** 드래그 중: 필요한 결과를 주고 경고 없이 놓을 수 있는 모듈 */
  dropUseful: "#06d6a0",
  /** 드래그 중: 놓을 수는 있지만 경고가 있는 모듈(필요 없는 결과, 대기열 초과 등) */
  dropWarn: "#ffd166",
  /** 드래그 중: 대기 구역에 놓을 수 있을 때 대기 구역 테두리 */
  dropPool: "#8ecae6",
  /** 드래그 툴팁 바탕·글자 */
  tooltipFill: "#000000",
  tooltipText: "#ffffff",
  tooltipWarn: "#ffd166",
  tooltipBlocked: "#ff6b6b",
  /** 경고 토스트 바탕·테두리·글자 */
  toastFill: "#3a2a1a",
  toastBorder: "#ffd166",
  toastText: "#ffe8b0",
} as const;

/** 화면 바깥 여백(px) */
export const MARGIN = 16;
/** 영역 사이 간격(px) */
export const GAP = 16;
/** 상단 상태 표시줄 높이(px) */
export const HUD_HEIGHT = 28;
/** 대기 구역 높이: 남은 높이에 대한 비율 */
export const POOL_HEIGHT_RATIO = 0.3;
/** 대기 구역 최소/최대 높이(px) */
export const POOL_MIN_HEIGHT = 80;
export const POOL_MAX_HEIGHT = 200;
/** 대기 구역 제목 줄 높이(px) */
export const POOL_TITLE_HEIGHT = 20;

/** 모듈 상자 최소/최대 너비(px). 최소 너비로 한 줄에 놓을 열 수를 정한다. */
export const MODULE_MIN_WIDTH = 140;
export const MODULE_MAX_WIDTH = 260;
/** 모듈 상자 최대 높이(px) */
export const MODULE_MAX_HEIGHT = 140;
/** 모듈 상자 위쪽 제목 줄 높이(px) */
export const MODULE_HEADER_HEIGHT = 22;
/** 모듈 상자 아래 대기열 영역 높이(px) */
export const QUEUE_AREA_HEIGHT = 26;
/** 모듈 상자 모서리 반경(px) */
export const MODULE_CORNER_RADIUS = 6;
/** 모듈 테두리 두께(px) */
export const MODULE_BORDER_WIDTH = 2;

/** 작업 원 최대 반지름(px) */
export const JOB_MAX_RADIUS = 18;
/** 작업 원 최소 반지름(px) */
export const JOB_MIN_RADIUS = 4;
/** 대기 구역 작업 원 반지름(px) */
export const POOL_JOB_RADIUS = 12;
/** 대기열 작업 원 반지름(px) */
export const QUEUE_JOB_RADIUS = 7;
/** 작업 원 사이 간격(px) */
export const JOB_SPACING = 6;
/** 작업 원 테두리 두께(px) */
export const JOB_OUTLINE_WIDTH = 1.5;

/** 진행률 링: 작업 원 바깥으로 떨어진 거리(px)와 두께(px) */
export const PROGRESS_RING_OFFSET = 4;
export const PROGRESS_RING_WIDTH = 3;
/** DONE_AT_MODULE 표시 링 거리(px)·두께(px)·점선 */
export const DONE_RING_OFFSET = 4;
export const DONE_RING_WIDTH = 2;
export const DONE_RING_DASH: readonly number[] = [4, 3];

/** 글꼴 */
export const FONT_FAMILY = "system-ui, sans-serif";
export const FONT_SIZE_HUD = 14;
export const FONT_SIZE_LABEL = 12;
export const FONT_SIZE_SMALL = 10;

/** 시간 표시 소수 자릿수 */
export const TIME_DECIMALS = 1;
/** 백분율 변환 */
export const PERCENT = 100;

/** 대기열 줄 끝에서 "대기 N" 글자에 남겨 둘 원 자리 수 */
export const QUEUE_LABEL_RESERVED_SLOTS = 3;
/** 모듈 제목 줄 배경에 결과 색을 섞는 투명도 */
export const HEADER_TINT_ALPHA = 0.35;
/** 파이 조각이 하나뿐일 때를 포함해 원 전체 각도 */
export const FULL_TURN = Math.PI * 2;
/** 파이·링 시작 각도 (12시 방향) */
export const START_ANGLE = -Math.PI / 2;

/** 드래그 강조 테두리 두께(px): 놓을 수 있는 모듈 / 포인터 아래 대상 */
export const DROP_HIGHLIGHT_WIDTH = 3;
export const DROP_HOVER_WIDTH = 6;
/** 드래그 중 놓을 수 없는 모듈의 투명도 */
export const DROP_BLOCKED_ALPHA = 0.3;
/** 드래그 중인 작업의 원래 자리 투명도 */
export const DRAG_GHOST_ALPHA = 0.3;
/** 포인터를 따라가는 작업 원의 투명도 */
export const DRAG_JOB_ALPHA = 0.9;
/** 드래그로 보기 시작하는 이동 거리(px). 이보다 적게 움직이고 놓으면 클릭으로 본다. */
export const DRAG_THRESHOLD = 5;
/** 작업 원 히트 판정 여유(px). 작은 원(대기열)도 손가락으로 잡기 쉽게 반지름에 더한다. */
export const HIT_SLOP = 4;

/** 드래그 툴팁: 포인터에서 떨어진 거리(px), 안쪽 여백(px), 줄 높이(px), 최대 줄 수, 투명도 */
export const TOOLTIP_OFFSET = 16;
export const TOOLTIP_PADDING = 6;
export const TOOLTIP_LINE_HEIGHT = 15;
export const TOOLTIP_MAX_LINES = 4;
export const TOOLTIP_ALPHA = 0.85;

/** 경고 토스트: 최대 개수, 보이는 시간(실제 ms), 사라지기 시작하는 남은 시간(ms) */
export const TOAST_MAX = 5;
export const TOAST_DURATION_MS = 4000;
export const TOAST_FADE_MS = 600;
/** 경고 토스트 크기(px): 너비, 줄 높이, 간격, 안쪽 여백 */
export const TOAST_WIDTH = 360;
export const TOAST_HEIGHT = 24;
export const TOAST_GAP = 6;
export const TOAST_PADDING = 8;
export const TOAST_BORDER_WIDTH = 1;
