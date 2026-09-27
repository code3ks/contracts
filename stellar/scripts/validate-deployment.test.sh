#!/usr/bin/env bash
# stellar/scripts/validate-deployment.test.sh
#
# Unit tests for validate-deployment.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VALIDATE_SCRIPT="$SCRIPT_DIR/validate-deployment.sh"
TEST_DIR=$(mktemp -d)
trap "rm -rf $TEST_DIR" EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
fail() { printf "${RED}✗${NC} %s\n" "$*"; exit 1; }

# Test 1: Valid deployment output
test_valid_deployment() {
    cat > "$TEST_DIR/valid-output.txt" <<'EOF'

═══ Results ═══

  Contract               Contract ID                                             
  ───────                ───────────                                             
  stealth-announcer      CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS
  stealth-registry       CBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST
  stealth-sender         CCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU
  wraith-names           CDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV

  Stellar Expert links:
  ├─ Announcer: https://futurenet.stellar.expert/explorer/futurenet/contract/CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS
  ├─ Registry:  https://futurenet.stellar.expert/explorer/futurenet/contract/CBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST
  ├─ Sender:    https://futurenet.stellar.expert/explorer/futurenet/contract/CCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU
  └─ Names:     https://futurenet.stellar.expert/explorer/futurenet/contract/CDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV

  ✔ All checks passed. Dry-run complete.

EOF

    if bash "$VALIDATE_SCRIPT" "$TEST_DIR/valid-output.txt" futurenet > /dev/null 2>&1; then
        ok "Test 1: Valid deployment output passes validation"
        return 0
    else
        fail "Test 1: Valid deployment output should pass validation"
    fi
}

# Test 2: Missing contract ID
test_missing_contract() {
    cat > "$TEST_DIR/missing-contract.txt" <<'EOF'

═══ Results ═══

  Contract               Contract ID                                             
  ───────                ───────────                                             
  stealth-announcer      CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS
  stealth-registry       CBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST
  stealth-sender         CCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU

  ✔ All checks passed. Dry-run complete.

EOF

    if bash "$VALIDATE_SCRIPT" "$TEST_DIR/missing-contract.txt" futurenet > /dev/null 2>&1; then
        fail "Test 2: Missing contract should fail validation"
    else
        ok "Test 2: Missing contract correctly fails validation"
        return 0
    fi
}

# Test 3: Invalid contract ID format (not starting with C)
test_invalid_format() {
    cat > "$TEST_DIR/invalid-format.txt" <<'EOF'

═══ Results ═══

  Contract               Contract ID                                             
  ───────                ───────────                                             
  stealth-announcer      AABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS
  stealth-registry       CBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST
  stealth-sender         CCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU
  wraith-names           CDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV

  ✔ All checks passed. Dry-run complete.

EOF

    if bash "$VALIDATE_SCRIPT" "$TEST_DIR/invalid-format.txt" futurenet > /dev/null 2>&1; then
        fail "Test 3: Invalid format should fail validation"
    else
        ok "Test 3: Invalid format correctly fails validation"
        return 0
    fi
}

# Test 4: Wrong network
test_wrong_network() {
    cat > "$TEST_DIR/wrong-network.txt" <<'EOF'

═══ Results ═══

  Contract               Contract ID                                             
  ───────                ───────────                                             
  stealth-announcer      CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS
  stealth-registry       CBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST
  stealth-sender         CCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU
  wraith-names           CDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV

  Stellar Expert links:
  ├─ Announcer: https://testnet.stellar.expert/explorer/testnet/contract/CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS

  ✔ All checks passed. Dry-run complete.

EOF

    if bash "$VALIDATE_SCRIPT" "$TEST_DIR/wrong-network.txt" futurenet > /dev/null 2>&1; then
        fail "Test 4: Wrong network should fail validation"
    else
        ok "Test 4: Wrong network correctly fails validation"
        return 0
    fi
}

# Test 5: Deployment with smoke test failures
test_smoke_test_failure() {
    cat > "$TEST_DIR/smoke-fail.txt" <<'EOF'

═══ Results ═══

  Contract               Contract ID                                             
  ───────                ───────────                                             
  stealth-announcer      CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS
  stealth-registry       CBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST
  stealth-sender         CCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU
  wraith-names           CDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV

  ⚠  Some smoke tests failed. Check output above for details.

EOF

    if bash "$VALIDATE_SCRIPT" "$TEST_DIR/smoke-fail.txt" futurenet > /dev/null 2>&1; then
        fail "Test 5: Smoke test failure should fail validation"
    else
        ok "Test 5: Smoke test failure correctly fails validation"
        return 0
    fi
}

# Run all tests
echo "Running validate-deployment.sh tests..."
echo ""

test_valid_deployment
test_missing_contract
test_invalid_format
test_wrong_network
test_smoke_test_failure

echo ""
echo "All tests passed!"
