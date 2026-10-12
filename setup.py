"""Bundle the build-free frontend without duplicating its editable sources."""

from pathlib import Path
from shutil import copytree, ignore_patterns

from setuptools import setup
from setuptools.command.build_py import build_py


class BuildWithAssets(build_py):
    def run(self):
        super().run()
        root = Path(__file__).resolve().parent
        for name in ("web", "ui"):
            copytree(root / name, Path(self.build_lib) / "reruns" / "assets" / name,
                     dirs_exist_ok=True,
                     ignore=ignore_patterns("tests", "__pycache__", "*.pyc"))


setup(cmdclass={"build_py": BuildWithAssets})
