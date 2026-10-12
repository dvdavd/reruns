from pathlib import Path
from unittest import mock

from reruns.assets import asset_root, default_cache_dir


def test_checkout_assets_are_available():
    assert (asset_root("web") / "index.html").is_file()
    assert (asset_root("ui") / "shared" / "index.js").is_file()
    assert (asset_root("ui") / "fonts" / "InterVariable.woff2").is_file()


def test_cache_uses_user_location_instead_of_installed_package():
    with mock.patch.dict("os.environ", {"XDG_CACHE_HOME": "/tmp/reruns-cache-test"}):
        assert default_cache_dir() == Path("/tmp/reruns-cache-test/reruns")
    with mock.patch.dict("os.environ", {}, clear=True), mock.patch(
            "reruns.assets.Path.home", return_value=Path("/tmp/reruns-home-test")):
        assert default_cache_dir() == Path("/tmp/reruns-home-test/.cache/reruns")
