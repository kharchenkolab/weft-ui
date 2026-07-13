"""Wizard support: ssh-config parsing, preflight classification, sinfo
parsing, and the argv validator — all pure functions."""

import textwrap

from weft_ui.wizard import (_validate, classify_preflight, parse_sinfo,
                            parse_ssh_config)


def test_parse_ssh_config_picks_concrete_hosts():
    text = textwrap.dedent("""\
        Host hpc
            HostName login.hpc.uni.edu
            User pk
        Host beamlab
            HostName beam03.facility.org
            User pk
            ProxyJump gateway.facility.org
        Host *.internal !prod
            User svc
        Host wkst old-wkst
            HostName 10.0.0.7
            Port 2222
    """)
    hosts = parse_ssh_config(text)
    by_name = {h["host"]: h for h in hosts}
    assert set(by_name) == {"hpc", "beamlab", "wkst", "old-wkst"}  # no wildcards
    assert by_name["hpc"]["hostname"] == "login.hpc.uni.edu"
    assert by_name["beamlab"]["jump"] == "gateway.facility.org"
    assert by_name["wkst"]["port"] == "2222"
    assert by_name["old-wkst"]["hostname"] == "10.0.0.7"  # multi-name block


def test_preflight_classification():
    assert classify_preflight(0, "") == "ok"
    assert classify_preflight(255, "pk@hpc: Permission denied (publickey).") == "auth"
    assert classify_preflight(255, "Host key verification failed.") == "hostkey"
    assert classify_preflight(255,
        "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!".lower()) == "hostkey"
    assert classify_preflight(255, "ssh: Could not resolve hostname hcp: "
                                   "nodename nor servname provided") == "dns"
    assert classify_preflight(255, "connect to host 10.1.2.3 port 22: "
                                   "Connection refused") == "network"
    assert classify_preflight(255, "connect to host hpc port 22: "
                                   "Operation timed out") == "network"
    assert classify_preflight(1, "some exotic failure") == "unknown"


def test_parse_sinfo_marks_default_and_gres():
    out = ("standard*|128|64|512000|7-00:00:00|(null)\n"
           "gpu|8|64|1024000|2-00:00:00|gpu:a100:8\n")
    parts = parse_sinfo(out)
    assert parts[0]["name"] == "standard" and parts[0]["default"] is True
    assert parts[0]["nodes"] == 128 and parts[0]["gres"] == ""
    assert parts[1]["default"] is False and parts[1]["gres"] == "gpu:a100:8"


def test_validator_blocks_hostile_input():
    assert _validate("host; rm -rf /", []) is not None
    assert _validate("user@host", ["-o", "ProxyCommand=evil"]) is not None  # exec vector
    assert _validate("user@host", ["-o", "LocalCommand=evil"]) is not None
    assert _validate("$(boom)", []) is not None
    assert _validate("good-host.example.org", ["-i", "/path/key", "-o",
                                               "StrictHostKeyChecking=no"]) is None
    assert _validate("a@b@c", []) is not None
