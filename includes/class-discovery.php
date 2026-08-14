<?php
/**
 * Discovery tags for print alternate in wp_head.
 *
 * @package PRC\Platform\Print_Engine
 */

namespace PRC\Platform\Print_Engine;

/**
 * Adds link rel="alternate" for print discovery.
 *
 * @package PRC\Platform\Print_Engine
 */
class Discovery {

	/**
	 * The loader instance.
	 *
	 * @var Loader
	 */
	protected $loader;

	/**
	 * Constructor.
	 *
	 * @param Loader $loader The loader instance.
	 */
	public function __construct( Loader $loader ) {
		$this->loader = $loader;

		$this->loader->add_action( 'wp_head', $this, 'add_print_alternate_link', 10 );
	}

	/**
	 * Add link rel="alternate" for the print document in head.
	 *
	 * @hook wp_head
	 */
	public function add_print_alternate_link() {
		if ( ! is_singular() ) {
			return;
		}

		global $post;
		if ( ! $post || 'publish' !== $post->post_status ) {
			return;
		}

		if ( ! post_type_supports( $post->post_type, 'prc-print-engine' ) ) {
			return;
		}

		if ( ! Print_Access::audience_may_see_print_ui() ) {
			return;
		}

		$print_url = Print_Engine::get_print_url( $post );
		if ( ! $print_url ) {
			return;
		}

		printf(
			'<link rel="alternate" type="text/html" title="%s" href="%s">' . "\n",
			esc_attr__( 'Print / PDF', 'prc-print-engine' ),
			esc_url( $print_url )
		);
	}
}
