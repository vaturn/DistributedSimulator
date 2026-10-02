import { defineConfig } from "vitest/config";

/**
 * 개발 서버가 바인딩할 주소.
 * 기본값("localhost")이면 127.0.0.1에만 열려서 WSL2 밖(Windows 브라우저)에서
 * 접속하지 못하는 경우가 있다. true면 모든 인터페이스(IPv4/IPv6)에 연다.
 */
const DEV_SERVER_HOST = true;
/** 개발 서버 포트 */
const DEV_SERVER_PORT = 5173;
/** 포트가 이미 쓰이고 있으면 다른 포트로 바꾸지 않고 실패한다(주소가 바뀌어 헷갈리지 않게). */
const DEV_SERVER_STRICT_PORT = true;

// Vite 개발 서버/빌드와 Vitest 테스트 설정을 한 곳에 둔다.
export default defineConfig({
  server: {
    host: DEV_SERVER_HOST,
    port: DEV_SERVER_PORT,
    strictPort: DEV_SERVER_STRICT_PORT,
  },
  preview: {
    host: DEV_SERVER_HOST,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
