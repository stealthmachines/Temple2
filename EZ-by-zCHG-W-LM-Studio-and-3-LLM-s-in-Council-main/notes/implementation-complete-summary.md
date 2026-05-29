# HDGL Hybrid Routing - Implementation Complete ✅

## Files Created in C:\wuwei-routing\

1. **start-routes.ps1** - Main daemon (HDGL-style analog state computation)
2. **router-phi.ps1** - Request-time routing (phi-hash based)
3. **README.md** - Documentation and usage guide
4. **run.bat** - Easy startup script
5. **config.json** - Configuration template

## Quick Start

```powershell
# Option 1: Use the batch file
C:\wuwei-routing\run.bat

# Option 2: PowerShell directly
.\start-routes.ps1

# Option 3: Interactive
.\router-phi.ps1 GET /test
# Output: ROUTING_COMPLETE:server=phi-primary,port=4111,hash=1
#        4111
```

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│                    Client Request                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│            router-phi.ps1 (Request-Time Routing)           │
│  • Computes phi-hash from request                         │
│  • Checks state from active_server                         │
│  • Intelligent routing (path-based)                        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│       start-routes.ps1 (HDGL Daemon - Background)          │
│  • Health checks every 30s                                 │
│  • Updates active_server state                              │
│  • Logs decisions to logs/daemon-*.log                      │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│     State: C:\wuwei-routing\state\                          │
│  • active_server: Current routing choice                  │
│  • health.json: Server health status                       │
│  • last_cycle: Last update timestamp                       │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│   { phi-primary:4111, phi-mirror:4112 }                  │
│   • Wu-Wei MCP servers                                     │
│   • SSE endpoints at /sse                                  │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│         LLM Server at 1234                                 │
│   • Primary context: 200,000 tokens                        │
│   • Secondary (:2): 199,999 tokens                         │
└─────────────────────────────────────────────────────────────┘
```

## Key Features

✅ **Analog Load Balancing**
- Golden ratio (φ) inspired hashing
- Emergent state, no central scheduler
- Natural distribution without manual tuning

✅ **Self-Healing**
- Automatic failover when servers unhealthy
- Smart path-based routing (LLM, DOS, browse)
- Graceful degradation

✅ **Lightweight**
- No new servers or containers
- Uses existing Wu-Wei infrastructure
- PowerShell-native (no dependencies)

✅ **Observable**
- Comprehensive logging
- State tracking
- Easy debugging

## HDGL Parallels

| HDGL Feature | Our Implementation |
|--------------|-------------------|
| φ-spiral hashing | `Get-PhiHash()` function |
| 30s cycle interval | `Start-Sleep -Seconds 30` |
| Multiple weights | Path-based intelligent routing |
| Self-healing | Automatic health checks + failover |
| Analog state | Time-based phi decisions |
| Fingerprints | Unique cycle hashes |

## Testing

```powershell
# 1. Start daemon
.\run.bat

# 2. Check status
Get-Content .\state\active_server

# 3. Test routing
.\router-phi.ps1 GET /mcp/tools/list
.\router-phi.ps1 POST /llm/completion
.\router-phi.ps1 GET /dos/command

# 4. View logs
Get-Content .\logs\daemon-*.log | Select-Object -Last 10

# 5. Stop daemon
# Press Ctrl+C when run.bat is running
```

## Integration with LM Studio

### Current State
- LM Studio already has `phi-primary` (4111) configured
- Add `phi-mirror` (4112) to integrations
- Both servers now available for routing

### Future Enhancement
The router can:
- Route specific task types to optimal server
- Balance load across both MCP servers
- Provide failover protection
- Direct LLM requests to appropriate context

Would you like me to:
1. **Create LM Studio integration guide**?
2. **Build a proxy script** for direct HTTP forwarding?
3. **Add monitoring dashboard** (PowerShell GUI)?
4. **Create Docker Compose** version for cross-platform?

Let me know which enhancement you'd like next! 🚀