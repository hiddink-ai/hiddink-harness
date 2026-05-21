#!/usr/bin/env bash

# hiddink-harness 글로벌 1-Line 설치 스크립트
# 사용법: curl -fsSL https://opencode.ai/install | bash

set -e

# 색상 터미널 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # Color Reset

echo -e "${BLUE}⚽ Hiddink Harness Universal Harness 설치를 시작합니다...${NC}"
echo "--------------------------------------------------------"

# 1. Node.js & npm 설치 감지
if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}오류: Node.js 가 감지되지 않았습니다.${NC}"
    echo "hiddink-harness는 Node.js 18 버전 이상이 필요합니다."
    echo "https://nodejs.org 에서 Node.js를 설치한 후 다시 시도해 주세요."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2)
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d'.' -f1)

if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "${YELLOW}경고: 감지된 Node.js 버전이 v$NODE_VERSION 입니다.${NC}"
    echo "hiddink-harness는 Node.js 18+ 환경에 최적화되어 있어 오작동할 수 있습니다."
fi

if ! command -v npm >/dev/null 2>&1; then
    echo -e "${RED}오류: npm 패키지 매니저가 감지되지 않았습니다.${NC}"
    echo "Node.js 설치와 함께 배포되는 npm이 필요합니다."
    exit 1
fi

# 2. 글로벌 설치 시도
echo -e "${BLUE}NPM 레지스트리로부터 hiddink-harness 글로벌 설치 중...${NC}"

# 글로벌 설치 권한 감지 및 분기
if [ -w "$(npm config get prefix)/lib/node_modules" 2>/dev/null ] || [ "$EUID" -eq 0 ]; then
    # 쓰기 권한이 있거나 루트인 경우 바로 설치
    npm install -g hiddink-harness
else
    # 일반 사용자 권한이며 글로벌 디렉토리에 쓰기 권한이 없는 경우 (EACCES 방지)
    echo -e "${YELLOW}글로벌 디렉토리 쓰기 권한이 필요합니다. sudo 권한으로 설치를 시도합니다...${NC}"
    sudo npm install -g hiddink-harness --unsafe-perm
fi

# 3. 설치 정상 검증
if command -v hiddink-harness >/dev/null 2>&1; then
    echo "--------------------------------------------------------"
    echo -e "${GREEN}🎉 hiddink-harness 가 성공적으로 설치되었습니다!${NC}"
    echo -e "설치 버전: ${BLUE}$(hiddink-harness -v)${NC}"
    echo ""
    echo -e "💡 ${GREEN}어디서든 아래와 같이 입력하여 즉시 사용하실 수 있습니다:${NC}"
    echo -e "   ${BLUE}hiddink-harness${NC}  (Ink TUI 대시보드 기동)"
    echo -e "   ${BLUE}hiddink-harness init${NC}  (가상 프로젝트 환경 셋업)"
    echo "--------------------------------------------------------"
else
    echo -e "${RED}오류: 설치는 완료되었으나 hiddink-harness 실행 파일을 찾을 수 없습니다.${NC}"
    echo "NPM 글로벌 바이너리 경로가 환경 변수(PATH)에 잡혀 있는지 확인해 주세요."
    echo "기본 경로: $(npm config get prefix)/bin"
    exit 1
fi
