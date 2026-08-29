const { Provider } = require("./provider");

class NullProvider extends Provider {
  async resolve() { return { candidate: null, rejected: [] }; }
  open() { return null; }
}

module.exports = { NullProvider };
