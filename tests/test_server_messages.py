"""The server's refusals are said again in the chosen language by matching their
English wording against the catalogue in web/locales/en-GB.js (see
serverMessage in web/i18n.js). A message the server gains without a line there
would simply stay in English, so this holds the two together."""
import ast
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAISED = {"ValueError", "PermissionError", "LookupError", "RuntimeError", "KeyError"}


def _text(node):
    """A message with `x` where a value is filled in, or None if it is not text."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(part.value if isinstance(part, ast.Constant) else "x" for part in node.values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _text(node.left), _text(node.right)
        return left + right if left is not None and right is not None else None
    return None


def _server_messages():
    found = {}
    for path in sorted((ROOT / "reruns").glob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Call) or not node.args:
                continue
            name = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", "")
            argument = node.args[1] if name == "send_error" and len(node.args) > 1 else node.args[0]
            if name in RAISED or name == "send_error":
                text = _text(argument)
                if text:
                    found.setdefault(text, f"{path.name}:{node.lineno}")
    return found


def _catalogue_patterns():
    source = (ROOT / "web" / "locales" / "en-GB.js").read_text(encoding="utf-8")
    patterns = []
    for match in re.finditer(r"^\s*'server\.\w+': '((?:[^'\\]|\\.)*)',$", source, re.M):
        text = re.sub(r"\\(.)", r"\1", match.group(1))
        parts = re.split(r"(\{\w+\})", text)
        patterns.append(re.compile("".join(".+?" if re.fullmatch(r"\{\w+\}", p) else re.escape(p) for p in parts)))
    return patterns


class ServerMessagesInTheCatalogue(unittest.TestCase):
    def test_every_message_the_server_can_refuse_with_has_wording_in_the_catalogue(self):
        patterns = _catalogue_patterns()
        self.assertGreater(len(patterns), 100)
        missing = [f"{where}: {text}" for text, where in _server_messages().items()
                   if not any(pattern.fullmatch(text) for pattern in patterns)]
        self.assertEqual(missing, [], "add these to the server.* keys in web/locales/en-GB.js")


if __name__ == "__main__":
    unittest.main()
