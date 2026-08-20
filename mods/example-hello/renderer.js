// Minimal SMLN mod: adds a console command and reacts to the game being ready.
// Runs in the renderer, alongside the console, with SMLN already installed.

SMLN.whenReady(function (api) {
  api.log('info', 'example-hello: game API captured, ' + Object.keys(api.game).length + ' namespaces')
})

SMLN.registerCommand({
  name: 'hello',
  summary: 'Example command added by a mod',
  usage: 'hello [name]',
  args: [{ name: 'name', optional: true, values: function () { return ['world', 'sandustry'] } }],
  run: function (args) {
    var who = args[0] || 'world'
    return ['hello, ' + who + '!', 'this command comes from mods/example-hello']
  },
})
