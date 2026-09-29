"""Run a trusted local grader while the executing process owns the OS lock."""
import errno
import hashlib
import json
import os
import pathlib
import types
import shutil
import sys
import tempfile
import time


def publish(target, value):
    fd, temporary = tempfile.mkstemp(prefix=target.stem + '-', suffix='.tmp', dir=target.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, target)
    finally:
        os.unlink(temporary)


def hashes(root):
    result = {}
    for directory, dirs, names in os.walk(root):
        for name in dirs + names:
            if pathlib.Path(directory, name).is_symlink():
                raise ValueError('SYMLINK_REFUSED')
        for name in names:
            file = pathlib.Path(directory, name)
            if file.is_file():
                digest = hashlib.sha256()
                with file.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(chunk)
                result[file.relative_to(root).as_posix()] = digest.hexdigest()
    return result


def main():
    directory, source, grader = map(pathlib.Path, sys.argv[1:4])
    expected_grader_hash = sys.argv[4]
    receipt = json.load(sys.stdin)
    # Same platform primitive as freeze-publish.py; the file is never deleted.
    with (directory / 'grading.guard').open('a+b') as lock:
        try:
            if os.name == 'nt':
                import msvcrt
                if os.fstat(lock.fileno()).st_size == 0:
                    lock.write(b'0')
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return 75
        execution_path = directory / 'grader-execution.json'
        if execution_path.exists():
            return 0
        # Execute the same bytes that match the registered entrypoint, not a later read.
        grader_bytes = grader.read_bytes()
        if hashlib.sha256(grader_bytes).hexdigest() != expected_grader_hash:
            return 76
        # Incomplete attempts remain separate. A surviving test subprocess cannot
        # write into a later attempt's copy. The paid workspace is never changed.
        attempt = pathlib.Path(tempfile.mkdtemp(prefix='grading-', dir=directory))
        snapshot, output = attempt / 'submission', attempt / 'external-grade.json'
        # Preserve links without following them; the snapshot check below refuses them.
        shutil.copytree(source, snapshot, symlinks=True)
        hashes(snapshot)
        context = {'receipt': receipt, 'gradingStartedAt': int(time.time() * 1000)}
        publish(attempt / 'grading-context.json', context)
        sys.argv = [str(grader), str(snapshot), str(output)]
        sys.path.insert(0, str(grader.parent))
        code = 0
        previous_main = sys.modules['__main__']
        module = types.ModuleType('__main__')
        module.__dict__.update(__file__=str(grader), __package__='', __spec__=None,
                               __loader__=None, __cached__=None)
        sys.modules['__main__'] = module
        try:
            exec(compile(grader_bytes, str(grader), 'exec'), module.__dict__)
        except SystemExit as error:
            code = error.code if isinstance(error.code, int) else (0 if error.code is None else 1)
        except Exception:
            code = 1
        finally:
            sys.modules['__main__'] = previous_main
        publish(execution_path, {'code': code, 'timedOut': False,
                                'attempt': attempt.name, 'submissionHashes': hashes(snapshot)})
        return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        code = 'SYMLINK_REFUSED' if str(error) == 'SYMLINK_REFUSED' else errno.errorcode.get(getattr(error, 'errno', None), 'EIO')
        print('EVAL_INPUT_ERROR:' + code, file=sys.stderr)
        sys.exit(74)
