contract_version: 1
candidate_revision: 1
candidate_digest: <sha256>
verify_commands: node _dev/verify.mjs --full; python .agents/gates/gate.py --ci --repo .
not_run: none                     # 分号分隔的未执行检查项；空写 none，条数须等于 verdict.not_run_count
