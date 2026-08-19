# Discord Rich Presence

Native SandLoader mod that publishes a Sandustry Rich Presence to the local Discord desktop client.

## Setup

1. Create an application in the Discord Developer Portal.
2. Copy its **Application ID**.
3. Install/enable this mod and approve its native Node.js permission when SandLoader asks.
4. Open **SandLoader Mods -> Discord Rich Presence -> Settings** and paste the Application ID.
5. Restart Sandustry.

Optional image keys must match Rich Presence assets configured for the same Discord application.

## Notes

- No npm packages are required. The mod speaks Discord's local RPC-over-IPC protocol directly.
- Discord Desktop must be running for the presence to appear.
- The mod retries automatically if Discord starts after Sandustry.
- Native access is required because Discord RPC uses a local OS IPC socket. SandLoader will correctly show its native-code warning before loading it.
