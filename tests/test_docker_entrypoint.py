import errno
import importlib.util
from pathlib import Path
from unittest.mock import Mock, call, patch

import pytest


spec = importlib.util.spec_from_file_location(
    "docker_entrypoint", Path(__file__).parents[1] / "scripts/docker-entrypoint.py")
entrypoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entrypoint)


@pytest.mark.parametrize("value", ["0", "-1", "abc", "1000:1000", "4294967295", ""])
def test_invalid_identity(monkeypatch, value):
    monkeypatch.setenv("PUID", value)
    with pytest.raises(ValueError, match="PUID"):
        entrypoint.identity("PUID")


def test_repairs_app_contents_without_following_symlinks(tmp_path):
    for name in ("config", "cache", "media", "outside"):
        (tmp_path / name).mkdir()
    (tmp_path / "config/settings.json").touch()
    (tmp_path / "cache/nested").mkdir()
    (tmp_path / "cache/nested/preview").touch()
    (tmp_path / "outside/untouched").touch()
    (tmp_path / "cache/link").symlink_to(tmp_path / "outside", target_is_directory=True)
    (tmp_path / "media/video.mp4").touch()
    def mounted_path(path):
        return tmp_path / path.lstrip("/") if path in {"/config", "/cache", "/media"} else Path(path)

    with patch.object(entrypoint, "Path", side_effect=mounted_path), \
            patch.object(entrypoint.os, "chown") as chown:
        entrypoint.prepare(12345, 23456)
    paths = {args.args[0].relative_to(tmp_path).as_posix() for args in chown.call_args_list}
    assert {"config", "config/settings.json", "cache", "cache/nested",
            "cache/nested/preview", "cache/link"} <= paths
    assert not paths & {"outside", "outside/untouched", "cache/link/untouched", "media", "media/video.mp4"}
    assert all(args.kwargs == {"follow_symlinks": False} for args in chown.call_args_list)


@pytest.mark.parametrize("root", [True, False])
def test_drops_privileges_before_exec(root):
    with patch.object(entrypoint, "prepare") as prepare, \
            patch.object(entrypoint, "sys") as sys, \
            patch.object(entrypoint, "os") as os:
        os.geteuid.return_value = 0 if root else 1000
        os.environ = {"PUID": "1234", "PGID": "5678"}
        sys.argv = ["entrypoint", "reruns", "--host", "0.0.0.0"]
        entrypoint.main()
        if root:
            prepare.assert_called_once_with(1234, 5678)
            assert os.method_calls == [call.geteuid(), call.setgroups([]),
                                      call.setgid(5678), call.setuid(1234),
                                      call.execvp("reruns", sys.argv[1:])]
        else:
            prepare.assert_not_called()
            os.setuid.assert_not_called()
        os.execvp.assert_called_once_with("reruns", sys.argv[1:])


@pytest.mark.parametrize("contents", [None, "video.mp4", ".keep", "subfolder"])
def test_only_empty_root_owned_media_is_assigned(tmp_path, contents):
    media = tmp_path / "media"
    media.mkdir()
    if contents == "subfolder":
        (media / contents).mkdir()
    elif contents:
        (media / contents).touch()
    original_stat = Path.stat

    def root_owned_stat(path, *args, **kwargs):
        result = original_stat(path, *args, **kwargs)
        return Mock(st_mode=result.st_mode, st_uid=0)

    with patch.object(Path, "stat", root_owned_stat), patch.object(entrypoint, "own") as own:
        entrypoint.prepare_media(media, 1234, 5678)
    if contents is None:
        own.assert_called_once_with(media, 1234, 5678)
    else:
        own.assert_not_called()


@pytest.mark.parametrize("symlink, uid", [(True, 0), (False, 1000)])
def test_media_owned_by_others_and_symlinks_are_untouched(symlink, uid):
    media = Mock()
    media.is_symlink.return_value = symlink
    media.is_dir.return_value = True
    media.stat.return_value.st_uid = uid
    with patch.object(entrypoint, "own") as own:
        entrypoint.prepare_media(media, 1234, 5678)
    own.assert_not_called()


def test_empty_read_only_media_is_supported(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    original_stat = Path.stat

    def root_owned_stat(path, *args, **kwargs):
        result = original_stat(path, *args, **kwargs)
        return Mock(st_mode=result.st_mode, st_uid=0)

    with patch.object(Path, "stat", root_owned_stat), \
            patch.object(entrypoint, "own", side_effect=OSError(errno.EROFS, "read-only")):
        entrypoint.prepare_media(media, 1234, 5678)
