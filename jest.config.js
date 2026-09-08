/**
 * Jest configuration for prc-print-engine unit tests.
 * Unit tests live under monorepo root tests/prc-print-engine/unit/.
 */
const path = require('path');

const unitRoot = path.resolve(__dirname, '../../tests/prc-print-engine/unit');

module.exports = {
	...require('@wordpress/scripts/config/jest-unit.config'),
	rootDir: __dirname,
	roots: [unitRoot],
	testMatch: ['**/*.test.js'],
};
