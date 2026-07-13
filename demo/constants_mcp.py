"""A tiny stdio MCP server for the demo: physical constants lookup.

Wire it into a workspace via .mcp.json:

    {"mcpServers": {"constants": {
        "command": "<python>", "args": ["<repo>/demo/constants_mcp.py"]}}}

First use in a chat conversation raises the foreign-server approval card;
"always allow" persists to the workspace's .weft-ui.json.
"""

import json
import sys

CONSTANTS = {
    "hbar": ("1.054571817e-34", "J s", "reduced Planck constant"),
    "k_B": ("1.380649e-23", "J/K", "Boltzmann constant"),
    "N_A": ("6.02214076e23", "1/mol", "Avogadro constant"),
    "e": ("1.602176634e-19", "C", "elementary charge"),
    "m_e": ("9.1093837139e-31", "kg", "electron mass"),
    "a_0": ("5.29177210544e-11", "m", "Bohr radius"),
    "Ry": ("13.605693122990", "eV", "Rydberg energy"),
    "THz_to_meV": ("4.135667696", "meV/THz", "photon energy per THz"),
}

TOOL = {
    "name": "lookup_constant",
    "description": ("Look up a physical constant by symbol (CODATA 2022). "
                    "Known: " + ", ".join(CONSTANTS)),
    "inputSchema": {"type": "object",
                    "properties": {"symbol": {"type": "string"}},
                    "required": ["symbol"]},
}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        mid, method = msg.get("id"), msg.get("method")

        def reply(result):
            sys.stdout.write(json.dumps(
                {"jsonrpc": "2.0", "id": mid, "result": result}) + "\n")
            sys.stdout.flush()

        if method == "initialize":
            reply({"protocolVersion":
                   msg["params"].get("protocolVersion", "2024-11-05"),
                   "capabilities": {"tools": {}},
                   "serverInfo": {"name": "constants", "version": "1.0.0"}})
        elif method and method.startswith("notifications/"):
            pass
        elif method == "tools/list":
            reply({"tools": [TOOL]})
        elif method == "tools/call":
            symbol = str(msg["params"]["arguments"].get("symbol", "")).strip()
            hit = CONSTANTS.get(symbol)
            text = (f"{symbol} = {hit[0]} {hit[1]} ({hit[2]})" if hit
                    else f"unknown symbol {symbol!r}; known: {', '.join(CONSTANTS)}")
            reply({"content": [{"type": "text", "text": text}]})
        elif mid is not None:
            reply({})  # ping etc.


if __name__ == "__main__":
    main()
