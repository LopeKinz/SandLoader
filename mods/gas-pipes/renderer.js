/* eslint-env browser */
'use strict'

SMLN.log('info', 'Gas Pipes 1.4.0 renderer loaded')

SMLN.registerCommand({
  name: 'gaspipes',
  summary: 'Show Gas Pipes live Pump diagnostics',
  usage: 'gaspipes',
  args: [],
  run: () => {
    const s = globalThis.__SMLN_GAS_PIPES_STATS__
    if (!s) {
      return [
        'Gas Pipes 1.4.0 renderer is loaded.',
        'The patched Pump code has not executed yet.',
        'Run a connected Pump, then run gaspipes again.',
        'If this stays unchanged, send the SandLoader patch report/log.',
      ]
    }
    return [
      'Gas Pipes ' + s.version,
      'pump cell checks: ' + s.checks,
      'gas cells recognized: ' + s.gasSeen,
      'gas cells emitted: ' + s.moved,
      'last gas type: ' + (s.lastType == null ? '-' : s.lastType),
      'last gas output: ' + (s.lastMove ? JSON.stringify(s.lastMove) : '-'),
    ]
  },
})
