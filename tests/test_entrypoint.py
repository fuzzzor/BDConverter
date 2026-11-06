"""Run with python3 -m unittest discover -s tests on a POSIX host."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ENTRYPOINT = Path(__file__).resolve().parents[1] / "entrypoint.sh"


class EntrypointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = os.environ.copy()
        for key in ("LIBRARY_DIR", "DEST_ROOT", "TZ", "TIMEZONE", "TEST_EXIT_CODE"):
            self.env.pop(key, None)
        self.env.update(
            OUTPUT_DIR=str(self.root / "output"),
            UPLOAD_DIR=str(self.root / "upload"),
            TEMP_DIR=str(self.root / "temp"),
            PATH=str(self.root) + os.pathsep + self.env["PATH"],
        )
        upstream = self.root / "docker-entrypoint.sh"
        upstream.write_text(
            '#!/bin/sh\n'
            'printf "LIBRARY=%s\\nTZ=%s\\n" "${LIBRARY_DIR:-}" "${TZ:-}"\n'
            'for arg do printf "ARG=%s\\n" "$arg"; done\n'
            'exit "${TEST_EXIT_CODE:-0}"\n'
        )
        upstream.chmod(0o755)

    def run_entrypoint(self, *args):
        return subprocess.run(
            ["/bin/sh", str(ENTRYPOINT), *args],
            cwd=self.root, env=self.env, capture_output=True, text=True,
            timeout=10,
        )

    def test_default_command_and_directories(self):
        result = self.run_entrypoint()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ARG=node\nARG=server.js\n", result.stdout)
        for name in ("output", "upload", "temp"):
            self.assertTrue((self.root / name).is_dir())

    def test_missing_legacy_script(self):
        self.env.update(DEST_ROOT="/library", TIMEZONE="Europe/Paris")
        result = self.run_entrypoint("node", "-r", "./dest-patch.js", "server.js", "extra")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("LIBRARY=/library\nTZ=Europe/Paris\n", result.stdout)
        self.assertIn("ARG=node\nARG=server.js\nARG=extra\n", result.stdout)
        self.assertIn("WARNING", result.stderr)

    def test_directory_instead_of_legacy_script(self):
        (self.root / "dest-patch.js").mkdir()
        result = self.run_entrypoint("node", "--require", "./dest-patch.js", "server.js")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("ARG=--require", result.stdout)
        self.assertIn("WARNING", result.stderr)

    def test_valid_script_is_preserved(self):
        (self.root / "dest-patch.js").write_text("// Custom patch\n")
        result = self.run_entrypoint("node", "-r", "./dest-patch.js", "server.js")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ARG=-r\nARG=./dest-patch.js\n", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_explicit_environment_takes_precedence(self):
        self.env.update(LIBRARY_DIR="/explicit", DEST_ROOT="/legacy", TZ="UTC", TIMEZONE="Europe/Paris")
        result = self.run_entrypoint()
        self.assertIn("LIBRARY=/explicit\nTZ=UTC\n", result.stdout)

    def test_other_preloads_are_not_removed(self):
        result = self.run_entrypoint("node", "-r", "./other.js", "server.js")
        self.assertIn("ARG=-r\nARG=./other.js\n", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_custom_command_and_exit_code(self):
        self.env["TEST_EXIT_CODE"] = "23"
        result = self.run_entrypoint("custom-command", "argument with spaces")
        self.assertEqual(result.returncode, 23)
        self.assertIn("ARG=custom-command\nARG=argument with spaces\n", result.stdout)


if __name__ == "__main__":
    unittest.main()
