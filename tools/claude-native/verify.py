#!/usr/bin/env python3
"""Private native-Claude ingress for omniconv's recorded-tool replay engine.

Run on an isolated conversion worker with the reviewed omniconv checkout on
PYTHONPATH. Never run uploaded code on the worker host. Original Claude JSONL
is authoritative; calls.json is a derived verifier input, not an OpenCode trace.
This verifies tool replay and selected filesystem scopes, not model inference
or approval to distribute unmasked data.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import time
import uuid
import zipfile
from datetime import datetime
from contextlib import contextmanager


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    digest, size = hashlib.sha256(), 0
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
            size += len(chunk)
    return {'sha256': digest.hexdigest(), 'bytes': size}


def evidence_members(manifest):
    """Every preserved generation participates in integrity and execution checks."""
    for item in manifest['files']:
        yield item['path'], item
    for item in manifest.get('history', []):
        generation = item['generation']
        if type(generation) is not int or generation < 0:
            raise ValueError('Invalid evidence generation')
        yield f"history/{generation}/{item['path']}", item


def jsonl(bundle, name):
    data = bundle.read(name)
    if data and not data.endswith(b'\n'):
        raise ValueError('Truncated native evidence: ' + name)
    for line in data.decode('utf-8', errors='strict').splitlines():
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError('Native record must be an object: ' + name)
        yield value


def semantic_gaps(bundle, manifest):
    """Recompute admission from bytes, not a client-supplied quality verdict."""
    records = {'user', 'assistant', 'system', 'attachment', 'progress', 'queue-operation', 'last-prompt', 'atis-latch',
               'cost-state', 'mode', 'summary', 'file-history-snapshot', 'custom-title', 'agent-name', 'agent-color',
               'tag', 'pr-link', 'api-request', 'api-request-blob', 'api-request-shape'}
    blocks = {'text', 'image', 'document', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking'}
    unknown_records, unknown_blocks = set(), set()
    for name, item in evidence_members(manifest):
        if not item['path'].startswith('claude/projects/') or not name.endswith('.jsonl'):
            continue
        for event in jsonl(bundle, name):
            kind = event.get('type') if isinstance(event.get('type'), str) else '<missing>'
            if kind not in records:
                unknown_records.add(kind)
            if kind not in ('user', 'assistant'):
                continue
            message = event.get('message')
            content = message.get('content') if isinstance(message, dict) else None
            if isinstance(content, str):
                continue
            if not isinstance(content, list):
                unknown_blocks.add('<invalid-content>')
                continue
            for block in content:
                kind = block.get('type') if isinstance(block, dict) and isinstance(block.get('type'), str) else '<missing>'
                if kind not in blocks:
                    unknown_blocks.add(kind)
    return {'unknown_record_types': sorted(unknown_records), 'unknown_block_types': sorted(unknown_blocks)}


def model_evidence(bundle, session):
    """A separate quality check: tool replay cannot prove model provenance."""
    result = {'status': 'unknown', 'scope': 'managed-inference',
              'identity_basis': 'provider-response-body', 'initial_workspace_provenance': 'user-supplied-unattested',
              'eligible': False, 'blockers': []}
    contract, isolation = session.get('contract'), session.get('modelIsolation')
    if not isinstance(contract, dict) or not isinstance(isolation, dict):
        return {**result, 'status': 'legacy_unverified', 'blockers': ['model_contract_or_journal_missing']}
    try:
        saved = json.loads(bundle.read('policy/contract.json'))
        contract_bytes = json.dumps(contract, ensure_ascii=False, separators=(',', ':')).encode()
        expected = session.get('contractSha256')
        valid = (saved.get('contract') == contract and saved.get('sha256') == expected and sha(contract_bytes) == expected
                 and contract.get('schema') == 1 and contract.get('sessionId') == session['id']
                 and contract.get('owner') == session['owner'] and contract.get('workspaceId') == session['workspaceId']
                 and contract.get('model') == session['model']
                 and contract.get('execution', {}).get('baseImage') == session['base']['image']
                 and contract.get('execution', {}).get('kind') == 'docker'
                 and contract.get('execution', {}).get('os') == 'linux'
                 and contract.get('execution', {}).get('shell') == '/bin/bash'
                 and contract.get('execution', {}).get('workingDirectory') == '/workspace'
                 and contract.get('harness', {}).get('name') == 'claude-code'
                 and contract.get('harness', {}).get('sdkVersion') == session.get('sdkVersion')
                 and contract.get('harness', {}).get('claudeVersion') == session.get('claudeVersion')
                 and contract.get('capture', {}).get('scope') == 'managed-inference'
                 and contract.get('capture', {}).get('modelIsolation') == 'exact')
        if not valid:
            return {**result, 'status': 'invalid', 'blockers': ['model_contract_integrity_mismatch']}
        raw = bundle.read('policy/model-requests.jsonl')
        resolved = isolation.get('resolvedModel')
        if not isinstance(resolved, str) or not resolved or session.get('authorization', {}).get('upstreamModel') != resolved:
            return {**result, 'blockers': ['bound_upstream_model_missing']}
        if resolved != session['model']:
            return {**result, 'status': 'invalid', 'blockers': ['bound_upstream_model_mismatch']}
        result['catalog_model'], result['resolved_upstream_model'] = session['model'], resolved
        result['contract_sha256'] = expected
        result['journal'] = {'sha256': sha(raw), 'bytes': len(raw)}
        if sha(raw) != isolation.get('evidenceSha256') or len(raw) != isolation.get('evidenceBytes'):
            return {**result, 'status': 'invalid', 'blockers': ['model_journal_integrity_mismatch']}
        requests, responses, identities = {}, {}, {}
        problems = set()
        for event in jsonl(bundle, 'policy/model-requests.jsonl'):
            if event.get('schema') != 1 or event.get('sessionId') != session['id']:
                problems.add('model_event_identity_mismatch')
            request_id = event.get('requestId')
            if not isinstance(request_id, str) or not request_id:
                problems.add('model_request_identity_missing')
                continue
            kind = event.get('type')
            if kind == 'request':
                if request_id in requests:
                    problems.add('duplicate_model_request')
                requests[request_id] = event
                if event.get('requestedModel') != session['model'] or event.get('resolvedModel') != resolved or event.get('contractSha256') != expected:
                    problems.add('requested_model_mismatch')
                if event.get('route') not in ('messages', 'count_tokens'):
                    problems.add('unknown_model_route')
            elif kind == 'response':
                if request_id in responses:
                    problems.add('duplicate_model_response')
                responses[request_id] = event
            elif kind == 'provider_identity':
                identities.setdefault(request_id, set()).add(event.get('providerModel'))
                if event.get('providerModel') != resolved or event.get('requestedModel') != session['model'] or event.get('resolvedModel') != resolved or event.get('source') != 'response-body':
                    problems.add('observed_model_mismatch')
            elif kind == 'rejected':
                problems.add('rejected_model_request')
            else:
                problems.add('unknown_model_event')
        if set(requests) != set(responses) or set(identities) - set(requests):
            problems.add('model_journal_incomplete')
        completed = 0
        for request_id, request in requests.items():
            if request.get('route') != 'messages':
                continue
            response = responses.get(request_id, {})
            status = response.get('status')
            if type(status) is int and status >= 400:
                # Failed upstream attempts remain in evidence. They do not
                # establish another model or count as completed inference.
                if response.get('providerModels') or identities.get(request_id):
                    problems.add('model_identity_on_failed_response')
                continue
            if type(status) is not int or not 200 <= status < 300 or response.get('completed') is not True or response.get('streamComplete') is not True:
                problems.add('inference_response_incomplete')
            if response.get('identity') != 'reported' or response.get('providerModels') != [resolved] or identities.get(request_id) != {resolved}:
                problems.add('inference_identity_missing_or_mixed')
            completed += 1
        if not completed:
            problems.add('no_completed_model_inference')
        if isolation.get('status') != 'observed' or isolation.get('expectedModel') != session['model'] or isolation.get('observedModels') != [resolved]:
            problems.add('model_summary_not_observed')
        invalid = bool(problems & {'model_event_identity_mismatch', 'requested_model_mismatch', 'observed_model_mismatch', 'rejected_model_request'})
        result.update(status='invalid' if invalid else 'unknown' if problems else 'observed', eligible=not problems,
                      completed_inference_requests=completed, blockers=sorted(problems))
        return result
    except (KeyError, ValueError, TypeError, AttributeError, UnicodeDecodeError):
        return {**result, 'status': 'unknown', 'blockers': ['model_evidence_unreadable']}


def stamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000


def docker(*args, timeout=180):
    result = subprocess.run(['docker', *args], capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Docker operation failed: ' + result.stderr.decode(errors='replace')[-1000:])
    return result.stdout.decode().strip()


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


@contextmanager
def record_failure(path, report):
    try:
        yield
    except Exception as error:
        report.update(status='UNVERIFIED', strict_verified=False,
                      failure={'type': type(error).__name__, 'message': str(error)})
        write(path, report)
        raise


def text_content(content):
    if isinstance(content, str):
        return content
    return '\n'.join(block.get('text', '') for block in content or [] if block.get('type') == 'text')


def agent_model_omission(bundle, session, manifest, call, result, stop):
    """Corroborate one reviewed SDK transform; retain the discrepancy as SOFT.

    SDK 0.3.306 / Claude 2.1.306's Agent schema omits model when
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set. Its executor safeParse strips that
    field before hooks. This controller hash pins the reviewed force setting
    and unchanged hook callback. It is applicability evidence, not attestation.
    """
    def reject():
        raise ValueError('Uncorroborated native Agent model omission: ' + call['id'])

    controller = session.get('contract', {}).get('harness', {}).get('controllerSha256')
    if (session.get('sdkVersion'), session.get('claudeVersion'), controller) != (
            '0.3.306', '2.1.306', 'fd1d3a901953f38fc866d6ce62ec5f80ef247f878d029ae47bb581832b26ab00'):
        reject()
    if not model_evidence(bundle, session)['eligible']:
        reject()
    native = result['native']
    if (result['block'].get('is_error') or not isinstance(native, dict)
            or not isinstance(native.get('agentId'), str) or not native['agentId']
            or native.get('status') not in ('async_launched', 'completed')
            or native.get('resolvedModel') != session['model']
            or stop['input'].get('hook_event_name') != 'PostToolUse'
            or stop['input'].get('tool_response') != native):
        reject()
    member = 'events/sdk.jsonl'
    entries = [item for item in manifest['files'] if item['path'] == member]
    if len(entries) != 1 or member not in bundle.namelist():
        reject()
    raw = bundle.read(member)
    if entries[0].get('sha256') != sha(raw) or entries[0].get('bytes') != len(raw):
        reject()
    # Validate framing and JSON before inspecting physical line witnesses.
    list(jsonl(bundle, member))
    witnesses = {'requested': [], 'result': [], 'child': []}
    for number, line in enumerate(raw.splitlines(), 1):
        if not line.strip():
            continue
        event = json.loads(line)
        message = event.get('message', {})
        content = message.get('content', [])
        reference = {'path': member, 'line': number, 'sha256': sha(line), 'uuid': event.get('uuid')}
        for block in content if isinstance(content, list) else []:
            if event.get('type') == 'assistant' and block.get('type') == 'tool_use' and block.get('id') == call['id']:
                if (block.get('name') != call['tool'] or block.get('input') != call['input']
                        or (event.get('agent_id') or event.get('session_id')) != call['session']):
                    reject()
                witnesses['requested'].append(reference)
            if event.get('type') == 'user' and block.get('type') == 'tool_result' and block.get('tool_use_id') == call['id']:
                if block != result['block'] or event.get('tool_use_result') != native:
                    reject()
                witnesses['result'].append(reference)
        if event.get('type') == 'assistant' and event.get('parent_tool_use_id') == call['id']:
            if event.get('agent_id') != native['agentId'] or message.get('model') != session['model']:
                reject()
            witnesses['child'].append(reference)
    if not all(witnesses.values()):
        reject()
    return {'kind': 'sdk_agent_model_omission', 'strict_verified': False,
            'requested_input': call['input'], 'effective_input': call['native_effective_input'],
            'resolved_model': native['resolvedModel'], 'controller_sha256': controller,
            'sdk_witnesses': witnesses, 'model_journal_sha256': session['modelIsolation']['evidenceSha256']}


def calls_from(bundle, session, manifest):
    hooks = list(jsonl(bundle, 'events/hooks.jsonl'))
    starts, stops = {}, {}
    for event in hooks:
        item = event['input']
        if item.get('hook_event_name') == 'PreToolUse':
            key = item['tool_use_id']
            if key in starts:
                raise ValueError('Ambiguous repeated tool execution: ' + key)
            starts[key] = event
        elif item.get('hook_event_name') in ('PostToolUse', 'PostToolUseFailure'):
            key = item['tool_use_id']
            if key in stops:
                raise ValueError('Ambiguous repeated tool completion: ' + key)
            stops[key] = event
    calls, results = {}, {}
    for name, file in evidence_members(manifest):
        if not file['path'].startswith('claude/projects/') or not file['path'].endswith('.jsonl'):
            continue
        for event in jsonl(bundle, name):
            if event.get('type') not in ('assistant', 'user'):
                continue  # Request-cache blobs repeat context; they are not executions.
            content = event.get('message', {}).get('content')
            if not isinstance(content, list):
                continue
            for block in content:
                if block.get('type') == 'tool_use':
                    key = block['id']
                    hook = starts.get(key)
                    if hook is None:
                        raise ValueError('No execution hook for native call: ' + key)
                    item = hook['input']
                    if item['tool_name'] != block['name']:
                        raise ValueError('Native transcript and hook disagree: ' + key)
                    requested, effective = block['input'], item['tool_input']
                    if requested != effective and not (
                            block['name'] == 'Agent' and isinstance(requested, dict) and isinstance(effective, dict)
                            and isinstance(requested.get('model'), str) and requested['model']
                            and {k: v for k, v in requested.items() if k != 'model'} == effective):
                        raise ValueError('Native transcript and hook disagree: ' + key)
                    call = {'id': key, 'tool': block['name'], 'input': block['input'],
                            'start': stamp(hook['time']), 'turn': hook['turn'],
                            'session': item.get('agent_id') or event.get('agentId') or session['id'], 'status': 'pending',
                            'source': {'path': name, 'uuid': event.get('uuid')}, 'native_read_witness': hook.get('witness'),
                            'native_cwd': item.get('cwd')}
                    if requested != effective:
                        call['native_effective_input'] = effective
                    if key in calls and (calls[key]['tool'], calls[key]['input']) != (call['tool'], call['input']):
                        raise ValueError('Conflicting native call identity: ' + key)
                    if key not in calls:
                        call['sources'] = [call['source']]
                        calls[key] = call
                    elif call['source'] not in calls[key]['sources']:
                        calls[key]['sources'].append(call['source'])
                elif block.get('type') == 'tool_result':
                    key = block['tool_use_id']
                    value = {'block': block, 'native': event.get('toolUseResult'), 'end': event.get('timestamp')}
                    if key in results and (results[key]['block'], results[key]['native']) != (block, value['native']):
                        raise ValueError('Conflicting native result identity: ' + key)
                    results[key] = value
    if set(starts) != set(calls):
        raise ValueError('Execution hooks and native calls do not form a complete set')
    if set(results) != set(calls):
        raise ValueError('Native calls and results do not form a complete set')
    for key, call in calls.items():
        if key not in results:
            raise ValueError('Native tool result missing: ' + key)
        result = results[key]
        block, native = result['block'], result['native']
        stop = stops.get(key)
        if stop is None:
            raise ValueError('Native tool completion hook missing: ' + key)
        if stop['turn'] != call['turn'] or stop['input']['tool_name'] != call['tool'] or stop['input']['tool_input'] != call.get('native_effective_input', call['input']):
            raise ValueError('Native tool completion hook disagrees: ' + key)
        if 'native_effective_input' in call:
            call['native_input_normalization'] = agent_model_omission(bundle, session, manifest, call, result, stop)
        call.update(status='error' if block.get('is_error') else 'completed',
                    output=text_content(block.get('content')), end=stamp(stop['time']))
        if call['end'] < call['start']:
            raise ValueError('Native execution interval runs backwards: ' + key)
        call['meta'] = {'native_tool_result': native}
        if isinstance(native, dict):
            if native.get('agentId'):
                call['meta']['child_session_id'] = native['agentId']
            # Structured stdout/stderr avoid comparing Claude's no-output UI
            # placeholder as if it were bytes printed by the user's command.
            if call['tool'] == 'Bash' and isinstance(native.get('stdout'), str) and isinstance(native.get('stderr'), str):
                call['output'] = native['stdout'] + native['stderr']
            if native.get('type') == 'file_unchanged':
                # This SDK optimization contains no read bytes. It cannot prove
                # that a replayed read matched; never invent bytes from after.
                call['native_file_unchanged'] = True
    return sorted(calls.values(), key=lambda call: (call['start'], call['id']))


def native_bash(verify, ctr, call, state):
    """Replay the recorded command without the generic converter's shell fixes.

    Claude's Bash result does not expose its numeric exit or actual shell argv.
    Command/cwd are evidence; /bin/bash -lc is a declared reproduction recipe.
    Therefore even matching stdout and success are SOFT, never strict proof.
    """
    inp, native = call['input'], call['meta']['native_tool_result']
    cmd, cwd = inp.get('command'), call.get('native_cwd')
    if not isinstance(cmd, str) or not cmd.strip():
        return {'outcome': 'not_replayable', 'reason': 'native_command_missing'}
    if not isinstance(cwd, str) or not cwd.startswith('/') or '\0' in cwd:
        return {'outcome': 'not_replayable', 'reason': 'native_cwd_missing'}
    if not isinstance(native, dict) or not all(isinstance(native.get(k), str) for k in ('stdout', 'stderr')):
        return {'outcome': 'no_evidence', 'why': 'native Bash stdout/stderr are missing'}
    if native.get('interrupted') or inp.get('run_in_background') or native.get('backgroundTaskId'):
        return {'outcome': 'not_replayable', 'reason': 'native_background_or_interrupted'}
    if any(native.get(key) for key in ('truncated', 'truncation', 'fullOutputPath', 'outputFile', 'isImage')):
        return {'outcome': 'not_replayable', 'reason': 'native_output_not_text_complete'}
    if verify.classify(cmd) in ('skipped_side_effect', 'server'):
        return {'outcome': 'not_replayable', 'reason': 'native_external_effect_or_server'}
    state.setdefault('commands', []).append(cmd)
    timeout_ms = inp.get('timeout', 120000)
    if type(timeout_ms) is not int or timeout_ms < 1 or timeout_ms > 600000:
        return {'outcome': 'not_replayable', 'reason': 'native_timeout_unsupported'}
    argv = ['docker', 'exec', '-w', cwd, ctr, 'timeout', str(timeout_ms / 1000), '/bin/bash', '-lc', cmd]
    began = time.monotonic()
    try:
        result = subprocess.run(argv, capture_output=True, timeout=timeout_ms / 1000 + 30)
    except subprocess.TimeoutExpired:
        return {'outcome': 'harness_error', 'reason': 'native_command_timeout'}
    stdout, stderr = result.stdout.decode(errors='replace'), result.stderr.decode(errors='replace')
    rec = {'recorded_command_sha256': sha(cmd.encode()), 'cwd': cwd, 'shell_recipe': ['/bin/bash', '-lc'],
           'actual_shell_argv_observed': False, 'numeric_recorded_exit': None, 'replay_exit': result.returncode,
           'recorded_stdout_sha256': sha(native['stdout'].encode()), 'recorded_stderr_sha256': sha(native['stderr'].encode()),
           'replay_stdout_sha256': sha(result.stdout), 'replay_stderr_sha256': sha(result.stderr),
           'seconds': round(time.monotonic() - began, 3)}
    if result.returncode == 124:
        return {**rec, 'outcome': 'harness_error', 'reason': 'native_command_timeout'}
    if (result.returncode != 0) != (call['status'] == 'error'):
        return {**rec, 'outcome': 'diverge', 'why': 'native Bash success/failure differs'}
    exact = stdout == native['stdout'] and stderr == native['stderr']
    # SDK output formatting can strip final newlines. Show that difference,
    # with separate raw hashes; never silently count it as an exact match.
    formatted = stdout.rstrip('\n') == native['stdout'].rstrip('\n') and stderr.rstrip('\n') == native['stderr'].rstrip('\n')
    if not exact and not formatted:
        return {**rec, 'outcome': 'diverge-soft', 'why': 'native Bash output differs; shell invocation is unobserved', 'output_exact': False, 'output': {'stdout': stdout, 'stderr': stderr}}
    return {**rec, 'outcome': 'diverge-soft', 'why': 'native Bash actual shell argv and numeric exit are unobserved',
            'output_exact': exact, 'output_diff': None if exact else 'trailing_newlines'}


NATIVE_EDIT = r'''
import hashlib, json, os, sys
request = json.load(sys.stdin)
tool, inp = request['tool'], request['input']
name = inp['file_path']
try:
    with open(name, 'rb') as source:
        original = source.read()
except FileNotFoundError:
    original = None
if tool == 'Write':
    result = inp['content'].encode('utf-8')
elif tool == 'Edit':
    if original is None:
        raise ValueError('native_edit_file_missing')
    old, new = inp['old_string'].encode('utf-8'), inp['new_string'].encode('utf-8')
    if not old:
        raise ValueError('native_empty_edit_unsupported')
    count = original.count(old)
    if not count or (count != 1 and not inp.get('replace_all', False)):
        raise ValueError('native_edit_exact_match_missing_or_ambiguous')
    result = original.replace(old, new, -1 if inp.get('replace_all', False) else 1)
else:
    raise ValueError('unsupported_native_edit')
os.makedirs(os.path.dirname(os.path.abspath(name)), exist_ok=True)
with open(name, 'wb') as target:
    target.write(result)
    target.flush()
    os.fsync(target.fileno())
print(json.dumps({'before_sha256': hashlib.sha256(original).hexdigest() if original is not None else None,
                  'after_sha256': hashlib.sha256(result).hexdigest(), 'bytes': len(result)}))
'''


def native_edit(ctr, call, state):
    """Apply literal native input; no redaction repair or whitespace matching."""
    inp, cwd = call['input'], call.get('native_cwd')
    if call['status'] != 'completed':
        return {'outcome': 'not_replayable', 'reason': 'native_failed_edit_semantics'}
    if not isinstance(cwd, str) or not cwd.startswith('/') or not isinstance(inp.get('file_path'), str):
        return {'outcome': 'not_replayable', 'reason': 'native_edit_path_missing'}
    fields = ('content',) if call['tool'] == 'Write' else ('old_string', 'new_string')
    if not all(isinstance(inp.get(key), str) for key in fields):
        return {'outcome': 'not_replayable', 'reason': 'native_edit_input_missing'}
    payload = json.dumps({'tool': call['tool'], 'input': inp}).encode()
    result = subprocess.run(['docker', 'exec', '-i', '-w', cwd, ctr, 'python3', '-c', NATIVE_EDIT],
                            input=payload, capture_output=True, timeout=60)
    if result.returncode:
        return {'outcome': 'diverge', 'why': 'native literal edit could not be applied', 'path': inp['file_path']}
    state.setdefault('touched', set()).add(inp['file_path'])
    return {'outcome': 'match', 'path': inp['file_path'], 'literal_input': True, **json.loads(result.stdout)}


def replay_verdict(replay, differences, selected):
    """Admission cannot inherit a permissive generic-verifier success label."""
    pairs = replay.get('per_call', [])
    if len(pairs) != len(selected) or {pair[0] for pair in pairs} != {call['id'] for call in selected}:
        return 'UNVERIFIED', False, ['execution_coverage_incomplete']
    outcomes = [pair[1].split(':', 1)[0] for pair in pairs]
    if any(differences.values()) or 'diverge' in outcomes:
        return 'DIFFERS', False, ['filesystem_or_tool_result_differs']
    allowed = {'match', 'diverge-soft', 'subagent'}
    blocked = sorted(set(outcomes) - allowed)
    if blocked:
        return ('TOOLS_RAN' if set(blocked) == {'tool-worked'} else 'UNVERIFIED'), False, blocked
    if not outcomes or all(outcome == 'subagent' for outcome in outcomes):
        return 'UNVERIFIED', False, ['no_tool_result_compared']
    soft = ('diverge-soft' in outcomes or bool(replay.get('matches_leaning_on'))
            or any(call.get('native_input_normalization') for call in selected))
    return ('VERIFIED_WITH_SOFT_DIFFS' if soft else 'VERIFIED'), True, []


def tree(container, scope):
    proc = subprocess.Popen(['docker', 'cp', container + ':' + scope, '-'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output = {}
    try:
        with tarfile.open(fileobj=proc.stdout, mode='r|') as archive:
            for member in archive:
                record = {'mode': member.mode, 'type': member.type.decode('ascii'), 'link': member.linkname,
                          'uid': member.uid, 'gid': member.gid}
                if member.isfile():
                    digest = hashlib.sha256()
                    with archive.extractfile(member) as data:
                        for chunk in iter(lambda: data.read(1024 * 1024), b''):
                            digest.update(chunk)
                    record.update(sha256=digest.hexdigest(), bytes=member.size)
                if member.name in output:
                    raise ValueError('Ambiguous filesystem archive member')
                output[member.name] = record
        if proc.wait(timeout=30):
            raise RuntimeError('Cannot inspect replay filesystem')
        return output
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.communicate()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('zip', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--check-path', action='append', default=[], help='Additional absolute filesystem scope to compare after every turn')
    args = parser.parse_args()
    from omniconv import verify
    original_replay = verify.replay_one
    def replay_native(ctr, root, call, index, calls, state, context):
        if call['tool'] == 'Bash':
            return native_bash(verify, ctr, call, state)
        if call['tool'] in ('Write', 'Edit'):
            return native_edit(ctr, call, state)
        if not call.get('native_file_unchanged') and not (call['tool'] == 'Read' and call.get('native_read_witness')):
            # Absolute native paths pass unchanged. Relative paths resolve from
            # the recorded hook cwd, never a guessed root or a repaired cwd.
            cwd = call.get('native_cwd')
            if not isinstance(cwd, str) or not cwd.startswith('/'):
                return {'outcome': 'not_replayable', 'reason': 'native_cwd_missing'}
            kind = verify.RT.kind_of(call['tool'])[0]
            if kind == 'shell':
                return {'outcome': 'not_replayable', 'reason': 'unsupported_native_shell'}
            if kind == 'edit':
                return {'outcome': 'not_replayable', 'reason': 'unsupported_native_edit'}
            return original_replay(ctr, cwd, call, index, calls, state, context)
        witness = call.get('native_read_witness')
        if call['status'] != 'completed':
            return {'outcome': 'not_replayable', 'reason': 'native_failed_read_semantics'}
        if not witness or witness.get('path') != call['input'].get('file_path') or not re.fullmatch(r'[a-f0-9]{64}', str(witness.get('sha256', ''))):
            return {'outcome': 'not_replayable', 'reason': 'native_cached_read_without_witness'}
        script = "import hashlib,json,os,stat,sys\np=sys.argv[1];s=os.stat(p)\nassert stat.S_ISREG(s.st_mode)\nh=hashlib.sha256()\nwith open(p,'rb') as f:\n for b in iter(lambda:f.read(1048576),b''):h.update(b)\nprint(json.dumps({'sha256':h.hexdigest(),'bytes':s.st_size,'mode':s.st_mode}))"
        code, output, _ = verify.sh(['docker', 'exec', ctr, 'python3', '-c', script, witness['path']], 60)
        actual = json.loads(output) if code == 0 and output.strip() else None
        expected = {key: witness.get(key) for key in ('sha256', 'bytes', 'mode')}
        return {'outcome': 'match' if actual == expected else 'diverge',
                'why': 'native cached read checked against the pre-tool byte witness',
                'recorded_witness': expected, 'replay_witness': actual, 'path': witness['path']}
    verify.replay_one = replay_native
    os.umask(0o077)
    args.out.mkdir(parents=True, exist_ok=False)
    scopes = ['/workspace', *args.check_path]
    if any(not scope.startswith('/') or '..' in Path(scope).parts for scope in scopes):
        raise ValueError('Check paths must be absolute')
    report = {'schema': 2, 'format': 'claude-code-native', 'verifier': verify.fingerprint(),
              'adapter_sha256': sha(Path(__file__).read_bytes()), 'network': 'none',
              'input_artifact': file_digest(args.zip),
              'filesystem_scopes': scopes, 'private': True, 'delivery_ready': False,
              'meaning': 'Recorded tool replay with explicit strict/soft outcomes. Original evidence is never rewritten. Delivery selection is separate.',
              'status': 'UNVERIFIED', 'turns': []}
    write(args.out / 'replay.json', report)
    with record_failure(args.out / 'replay.json', report), zipfile.ZipFile(args.zip) as bundle:
        if len(bundle.namelist()) != len(set(bundle.namelist())):
            raise ValueError('Duplicate ZIP member')
        session_bytes, manifest_bytes = bundle.read('session.json'), bundle.read('native-manifest.json')
        session, manifest = json.loads(session_bytes), json.loads(manifest_bytes)
        report['adapter_source'] = 'external'
        report['embedded_adapter_sha256'] = sha(bundle.read('verify.py')) if 'verify.py' in bundle.namelist() else None
        report['embedded_adapter_matches_external'] = report['embedded_adapter_sha256'] == report['adapter_sha256']
        report['session_sha256'], report['manifest_sha256'] = sha(session_bytes), sha(manifest_bytes)
        report['model_isolation'] = model_evidence(bundle, session)
        report['session_id'] = session['id']
        if manifest['sessionId'] != session['id'] or manifest['status'] != 'complete' or session['capture'] != 'complete':
            raise ValueError('Incomplete native session cannot pass replay admission')
        checked = set()
        for name, item in evidence_members(manifest):
            if name in checked or '\\' in name or name.startswith('/') or '..' in name.split('/'):
                raise ValueError('Ambiguous native evidence path')
            checked.add(name)
            content = bundle.read(name)
            if len(content) != item['bytes'] or sha(content) != item['sha256']:
                raise ValueError('Native evidence integrity failure: ' + name)
        if 'events/hooks.jsonl' not in checked:
            raise ValueError('Execution hooks are not covered by the native manifest')
        report['evidence_generations_checked'] = len(checked)
        report['semantic_gaps'] = semantic_gaps(bundle, manifest)
        report['semantic_review_required'] = any(report['semantic_gaps'].values())
        calls = calls_from(bundle, session, manifest)
        report['input_normalizations'] = [{'id': call['id'], **call['native_input_normalization']}
                                          for call in calls if call.get('native_input_normalization')]
        if any(call['turn'] not in {turn['number'] for turn in session['turns']} for call in calls):
            raise ValueError('A native call lies outside the captured turn sequence')
        write(args.out / 'calls.json', calls)
        report['calls_artifact'] = file_digest(args.out / 'calls.json')
        checkpoints = [session['base'], *[turn['after'] for turn in session['turns']]]
        if not session['turns'] or any(turn['status'] != 'complete' for turn in session['turns']):
            raise ValueError('Every admitted turn must have completed')
        if [turn['number'] for turn in session['turns']] != list(range(1, len(session['turns']) + 1)):
            raise ValueError('Native user turn sequence is incomplete or ambiguous')
        loaded = set()
        for cp in checkpoints:
            if not re.fullmatch(r'sha256:[a-f0-9]{64}', cp['image']):
                raise ValueError('Invalid image digest')
            if cp['file'] in loaded:
                continue
            if not re.fullmatch(r'images/[a-f0-9]{64}\.tar\.gz', cp['file']):
                raise ValueError('Invalid image archive path')
            with tempfile.NamedTemporaryFile(suffix='.tar.gz') as target:
                digest = hashlib.sha256(); size = 0
                with bundle.open(cp['file']) as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        digest.update(chunk); size += len(chunk); target.write(chunk)
                target.flush()
                if digest.hexdigest() != cp['sha256'] or size != cp['bytes']:
                    raise ValueError('Environment archive integrity failure')
                docker('load', '--input', target.name, timeout=600)
            loaded.add(cp['file'])
        for turn in session['turns']:
            if turn['number'] < 1 or turn['before']['image'] != checkpoints[turn['number'] - 1]['image']:
                raise ValueError('Broken before/after environment chain')
            selected = [call for call in calls if call['turn'] == turn['number']]
            name = 'omnirush-native-replay-' + uuid.uuid4().hex
            expected = name + '-expected'
            try:
                common = ['--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=4g', '--cpus=2']
                docker('run', '-d', '--name', name, *common, turn['before']['image'], 'sleep', 'infinity')
                docker('create', '--name', expected, *common, turn['after']['image'])
                replay = verify.replay_calls(name, '/workspace', selected, context={'main': session['id'], 'sessions': sorted({call['session'] for call in calls})})
                differences = {}
                for scope in scopes:
                    actual_tree, expected_tree = tree(name, scope), tree(expected, scope)
                    differences[scope] = [key for key in sorted(set(actual_tree) | set(expected_tree)) if actual_tree.get(key) != expected_tree.get(key)]
                status, accepted, blockers = replay_verdict(replay, differences, selected)
                if report['semantic_review_required']:
                    status, accepted = 'UNVERIFIED', False
                    blockers.append('unknown_native_semantics')
                report['turns'].append({'number': turn['number'], 'before_image': turn['before']['image'], 'after_image': turn['after']['image'],
                                        'calls': len(selected), 'accepted': accepted, 'strict_verified': status == 'VERIFIED',
                                        'status': status, 'blockers': blockers, 'replay': replay, 'filesystem_differences': differences})
                write(args.out / 'replay.json', report)
            finally:
                subprocess.run(['docker', 'rm', '-f', name, expected], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if file_digest(args.zip) != report['input_artifact']:
        report.update(status='UNVERIFIED', strict_verified=False, failure={'type': 'input_integrity', 'message': 'Input artifact changed during replay'})
        write(args.out / 'replay.json', report)
        raise ValueError('Input artifact changed during replay')
    if all(turn['accepted'] for turn in report['turns']):
        report['status'] = 'VERIFIED' if all(turn['strict_verified'] for turn in report['turns']) else 'VERIFIED_WITH_SOFT_DIFFS'
    elif any(turn['status'] == 'DIFFERS' for turn in report['turns']):
        report['status'] = 'DIFFERS'
    elif any(turn['status'] == 'TOOLS_RAN' for turn in report['turns']):
        report['status'] = 'TOOLS_RAN'
    report['strict_verified'] = report['status'] == 'VERIFIED'
    blockers = list(report['model_isolation']['blockers'])
    if report['status'] not in ('VERIFIED', 'VERIFIED_WITH_SOFT_DIFFS'):
        blockers.append('tool_replay_not_verified')
    if report['semantic_review_required']:
        blockers.append('unknown_native_semantics')
    report['quality_admission'] = {'eligible': not blockers, 'blockers': blockers,
                                   'retained': True, 'delivery_selection': 'separate'}
    write(args.out / 'replay.json', report)
    print(json.dumps({'session_id': report['session_id'], 'status': report['status'], 'turns': len(report['turns']), 'report': str(args.out / 'replay.json')}))
    return 0 if report['status'] in ('VERIFIED', 'VERIFIED_WITH_SOFT_DIFFS') else 1


if __name__ == '__main__':
    raise SystemExit(main())
