<?php
/**
 * PRC Print Engine
 *
 * @package           PRC_Print_Engine
 * @author            Pew Research Center
 * @copyright         2026 Pew Research Center
 * @license           GPL-2.0-or-later
 *
 * @wordpress-plugin
 * Plugin Name:       PRC Print Engine
 * Plugin URI:        https://github.com/pewresearch/prc-platform
 * Description:       Print-styled post preview, server-side PDF export via Firebase, and a block callback registry.
 * Version:           1.0.0
 * Requires at least: 6.8
 * Requires PHP:      8.2
 * Author:            Pew Research Center
 * Author URI:        https://pewresearch.org
 * License:           GPL-2.0+
 * License URI:       http://www.gnu.org/licenses/gpl-2.0.txt
 * Text Domain:       prc-print-engine
 * Requires Plugins:  prc-scripts
 */

namespace PRC\Platform\Print_Engine;

// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
	die;
}
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'PRC_PRINT_ENGINE_FILE', __FILE__ );
define( 'PRC_PRINT_ENGINE_DIR', __DIR__ );
define( 'PRC_PRINT_ENGINE_VERSION', '1.0.0' );

/**
 * Soft dependencies (optional, guarded at call sites):
 * - prc-report-package (multi-chapter assembly)
 * - prc-staff-bylines (cover bylines)
 * - prc-schema-seo (cover contact resolver)
 * - prc-block-library (table-of-contents block helpers during transition)
 */

require plugin_dir_path( __FILE__ ) . 'includes/class-bootstrap.php';

/**
 * Begins execution of the plugin.
 *
 * @since 1.0.0
 */
function run_prc_print_engine() {
	$plugin = new Bootstrap();
	$plugin->run();
}
run_prc_print_engine();
