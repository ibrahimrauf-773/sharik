#!/usr/bin/env bash
# API smoke test against a running server (default http://localhost:3000). Mutates data — re-seed afterwards: npm run seed
set -euo pipefail
B=${BASE:-http://localhost:3000}/api/v1
j(){ node -pe "const o=JSON.parse(require('fs').readFileSync(0));$1"; }
curl -fsS ${BASE:-http://localhost:3000}/health >/dev/null && echo "✓ health"
T=$(curl -fsS $B/auth/login -H 'content-type: application/json' -d '{"email":"investor@sharik.demo","password":"Investor@123"}' | j o.accessToken); echo "✓ login"
I=$(curl -fsS $B/campaigns/taleem-box/invest -H "authorization: Bearer $T" -H 'content-type: application/json' -H "Idempotency-Key: smoke-$(date +%s)" -d '{"amount":150000,"consentRisk":true,"consentContract":true}')
P=$(echo "$I" | j o.payment.id); R=$(echo "$I" | j o.ref); echo "✓ reserved $R"
curl -fsS -X POST $B/payments/$P/mock-pay -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{}' >/dev/null
for i in $(seq 1 30); do S=$(curl -fsS $B/investments/$R -H "authorization: Bearer $T" | j o.status); [ "$S" = escrow ] && break; sleep 0.5; done
[ "$S" = escrow ] && echo "✓ webhook → escrow" || { echo "✗ status $S"; exit 1; }
curl -fsS $B/investments/$R/contract.pdf -H "authorization: Bearer $T" | head -c4 | grep -q %PDF && echo "✓ contract pdf"
A=$(curl -fsS $B/auth/login -H 'content-type: application/json' -d '{"email":"admin@sharik.demo","password":"Admin@123"}' | j o.accessToken)
curl -fsS $B/admin/ledger -H "authorization: Bearer $A" | j o.balanced | grep -q true && echo "✓ ledger balanced"
echo "ALL SMOKE CHECKS PASSED"
