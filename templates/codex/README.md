# Constrained Codex host templates

These files are documentation inputs for approval codex prepare. The command
renders an instance-specific bundle with absolute paths and hashes.

Generated output is inert. Do not copy it into /etc/codex, load its launchd
units, create service accounts, or start its launchers until the policy-bound
broker and confined runner are installed and strict doctor reports ready.
APRV-325.1 always reports them as not ready.
