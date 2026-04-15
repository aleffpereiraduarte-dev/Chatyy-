module.exports = new Proxy({}, {
  get: () => {
    return function () {
      throw new Error('[web-stub] native-only module was called on web');
    };
  },
});
