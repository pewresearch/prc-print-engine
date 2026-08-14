<?php
declare(strict_types=1);
/**
 * Tests for print body front-matter strip / details extraction.
 *
 * Run with:
 *   php plugins/prc-print-engine/tests/test-prepare-print-body.php
 *
 * @package PRC\Platform\Print_Engine
 */

namespace {

	if ( ! class_exists( 'WP_HTML_Tag_Processor' ) ) {
		class WP_HTML_Tag_Processor {
			public function __construct( string $html ) {}
			public function next_tag(): bool {
				return false;
			}
			public function set_attribute( string $name, string $value ): void {}
			public function get_attribute( string $name ) {
				return null;
			}
			public function get_updated_html(): string {
				return '';
			}
		}
	}

	if ( ! class_exists( 'WP_Block_Type_Registry' ) ) {
		class WP_Block_Type_Registry {
			private static $instance = null;
			public static function get_instance() {
				return self::$instance ??= new self();
			}
			public function get_all_registered(): array {
				return array();
			}
		}
	}

	if ( ! class_exists( 'WP_Post' ) ) {
		class WP_Post {
			public $ID = 1;
			public $post_content = '';
			public $post_title = '';
			public $post_type = 'post';
			public $post_status = 'publish';
			public $post_password = '';
		}
	}

	if ( ! function_exists( 'get_the_title' ) ) {
		function get_the_title( $post = 0 ) {
			if ( is_object( $post ) && isset( $post->post_title ) ) {
				return (string) $post->post_title;
			}
			return '';
		}
	}

	if ( ! function_exists( 'parse_blocks' ) ) {
		function parse_blocks( $content ) {
			// Minimal parse for these fixtures — rely on serialize round-trip shape.
			$blocks = array();
			if ( preg_match_all(
				'/<!-- wp:([a-z0-9\-\/]+)(\s+(\{.*?\}))?\s+(\/)?-->(.*?)(?:<!-- \/wp:\1 -->)?/s',
				(string) $content,
				$matches,
				PREG_SET_ORDER
			) ) {
				foreach ( $matches as $m ) {
					$attrs = array();
					if ( ! empty( $m[3] ) ) {
						$decoded = json_decode( $m[3], true );
						if ( is_array( $decoded ) ) {
							$attrs = $decoded;
						}
					}
					$inner = $m[5] ?? '';
					$blocks[] = array(
						'blockName'    => $m[1],
						'attrs'        => $attrs,
						'innerHTML'    => $inner,
						'innerContent' => array( $inner ),
						'innerBlocks'  => array(),
					);
				}
			}
			return $blocks;
		}
	}

	if ( ! function_exists( 'serialize_block' ) ) {
		function serialize_block( $block ) {
			$name = $block['blockName'] ?? '';
			if ( '' === $name ) {
				return (string) ( $block['innerHTML'] ?? '' );
			}
			$attrs = ! empty( $block['attrs'] ) ? ' ' . wp_json_encode( $block['attrs'] ) : '';
			$html  = (string) ( $block['innerHTML'] ?? '' );
			if ( ! empty( $block['attrs']['selfClosing'] ) || '' === trim( $html ) && empty( $block['innerBlocks'] ) ) {
				return "<!-- wp:{$name}{$attrs} /-->";
			}
			return "<!-- wp:{$name}{$attrs} -->{$html}<!-- /wp:{$name} -->";
		}
	}

	if ( ! function_exists( 'wp_json_encode' ) ) {
		function wp_json_encode( $data ) {
			return json_encode( $data );
		}
	}

	if ( ! function_exists( 'wp_strip_all_tags' ) ) {
		function wp_strip_all_tags( $string ) {
			return trim( strip_tags( (string) $string ) );
		}
	}

	if ( ! function_exists( 'render_block' ) ) {
		function render_block( $block ) {
			return (string) ( $block['innerHTML'] ?? '' );
		}
	}

	if ( ! defined( 'PRC_PRINT_ENGINE_VERSION' ) ) {
		define( 'PRC_PRINT_ENGINE_VERSION', '0.0.0-test' );
	}
	if ( ! defined( 'PRC_PRINT_ENGINE_FILE' ) ) {
		define( 'PRC_PRINT_ENGINE_FILE', dirname( __DIR__ ) . '/prc-print-engine.php' );
	}
	if ( ! defined( 'ENT_HTML5' ) ) {
		define( 'ENT_HTML5', 16 );
	}
}

namespace PRC\Platform\Print_Engine {

	require_once dirname( __DIR__ ) . '/includes/class-loader.php';
	require_once dirname( __DIR__ ) . '/includes/class-block-print-registry.php';
	require_once dirname( __DIR__ ) . '/includes/class-print-engine.php';

	$failures = 0;
	$assert   = static function ( bool $cond, string $msg ) use ( &$failures ): void {
		if ( ! $cond ) {
			fwrite( STDERR, "FAIL: {$msg}\n" );
			++$failures;
			return;
		}
		fwrite( STDOUT, "OK: {$msg}\n" );
	};

	$engine = new class() extends Print_Engine {
		public function __construct() {}

		public function call( string $method, ...$args ) {
			$ref = new \ReflectionClass( Print_Engine::class );
			$m   = $ref->getMethod( $method );
			return $m->invoke( $this, ...$args );
		}

		/**
		 * Invoke a private method whose last argument is by-reference.
		 *
		 * @param string $method Method name.
		 * @param mixed  $first  First argument.
		 * @param array  $seen   By-reference accumulator.
		 * @return mixed
		 */
		public function call_dedupe( string $method, $first, array &$seen ) {
			$ref = new \ReflectionClass( Print_Engine::class );
			$m   = $ref->getMethod( $method );
			$args = array( $first, &$seen );
			return $m->invokeArgs( $this, $args );
		}
	};

	$assert(
		'research' === $engine->call(
			'classify_details_block',
			array(
				'blockName' => 'core/details',
				'attrs'     => array( 'className' => 'is-style-plus-icon' ),
				'innerHTML' => '<details><summary>About this research</summary></details>',
			)
		),
		'classifies About this research by summary'
	);

	$assert(
		'pew_knight' === $engine->call(
			'classify_details_block',
			array(
				'blockName' => 'core/details',
				'attrs'     => array( 'className' => 'is-style-pew-knight-co-branded' ),
				'innerHTML' => '<details><summary>Pew Knight Initiative</summary></details>',
			)
		),
		'classifies Pew-Knight by style class'
	);

	$assert(
		'' === $engine->call(
			'classify_details_block',
			array(
				'blockName' => 'core/details',
				'attrs'     => array(),
				'innerHTML' => '<details><summary>Other details</summary></details>',
			)
		),
		'ignores unrelated details'
	);

	$assert(
		$engine->call( 'titles_match', 'How Americans Are Engaged', 'how americans are engaged' ),
		'titles_match is case-insensitive'
	);

	$seen  = array();
	$first = $engine->call_dedupe(
		'dedupe_extracted_html',
		'<p>This report looks at views. Here are the survey questions&nbsp;used for this report.<a id="_msocom_1"></a></p>',
		$seen
	);
	$second = $engine->call_dedupe(
		'dedupe_extracted_html',
		'<p>This report looks at views. Here are the survey questions used for this report.</p>',
		$seen
	);
	$assert( '' !== $first, 'dedupe keeps the first extracted copy' );
	$assert( '' === $second, 'dedupe collapses &nbsp; / stripped-anchor variants' );

	$seen_nbsp      = array();
	$with_nbsp_char = $engine->call_dedupe(
		'dedupe_extracted_html',
		"<p>Identical copy with\xC2\xA0nbsp char.</p>",
		$seen_nbsp
	);
	$with_plain = $engine->call_dedupe(
		'dedupe_extracted_html',
		'<p>Identical copy with nbsp char.</p>',
		$seen_nbsp
	);
	$assert( '' !== $with_nbsp_char, 'dedupe keeps first NBSP-char copy' );
	$assert( '' === $with_plain, 'dedupe collapses U+00A0 to plain space' );

	// Orphan </div> from a missing core/buttons wrapper (Political Typology quiz CTA).
	$malformed = '<div class="print-engine-chapter__content">'
		. '<div class="wp-block-group">'
		. '<p>Where do you fit?</p>'
		. '<div class="wp-block-button"><a href="/quiz">Take the quiz</a></div>'
		. '</div>'
		. '</div>' // orphan — would close chapter__content / print mount early
		. '<h4>More politically mixed groups</h4>'
		. '<p>Americans in the other five groups…</p>'
		. '</div>';
	$balanced = $engine->call( 'strip_orphan_closing_divs', $malformed );
	$assert(
		substr_count( strtolower( $malformed ), '</div>' ) - 1
			=== substr_count( strtolower( $balanced ), '</div>' ),
		'strip_orphan_closing_divs removes exactly one orphan close'
	);
	$assert(
		false !== strpos( $balanced, 'More politically mixed groups' )
			&& substr_count( strtolower( $balanced ), '<div' ) === substr_count( strtolower( $balanced ), '</div>' ),
		'strip_orphan_closing_divs balances div open/close counts'
	);
	$assert(
		$engine->call( 'strip_orphan_closing_divs', '<p>No divs here</p>' ) === '<p>No divs here</p>',
		'strip_orphan_closing_divs is a no-op without divs'
	);

	// rebuild_block_inners preserves multi-tag leading/trailing wrappers.
	$rebuilt = $engine->call(
		'rebuild_block_inners',
		array(
			'blockName'    => 'core/group',
			'attrs'        => array(),
			'innerHTML'    => '<div class="wp-block-group"><div class="wp-block-group__inner-container"></div></div>',
			'innerContent' => array(
				'<div class="wp-block-group"><div class="wp-block-group__inner-container">',
				null,
				'</div></div>',
			),
			'innerBlocks'  => array(
				array(
					'blockName'    => 'core/paragraph',
					'attrs'        => array(),
					'innerHTML'    => '<p>Hi</p>',
					'innerContent' => array( '<p>Hi</p>' ),
					'innerBlocks'  => array(),
				),
			),
		),
		array(
			array(
				'blockName'    => 'core/paragraph',
				'attrs'        => array(),
				'innerHTML'    => '<p>Hi</p>',
				'innerContent' => array( '<p>Hi</p>' ),
				'innerBlocks'  => array(),
			),
		)
	);
	$assert(
		isset( $rebuilt['innerContent'][0] )
			&& false !== strpos( $rebuilt['innerContent'][0], 'wp-block-group__inner-container' ),
		'rebuild_block_inners keeps nested wrapper open fragment'
	);
	$assert(
		'</div></div>' === end( $rebuilt['innerContent'] ),
		'rebuild_block_inners keeps nested wrapper close fragment'
	);

	exit( $failures > 0 ? 1 : 0 );
}
