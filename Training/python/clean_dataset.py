from modules.cleaning import build_clean_parser, run_cleaning


def main() -> None:
    parser = build_clean_parser()
    args = parser.parse_args()
    input_path, output_path, stats = run_cleaning(args)

    print(f'Input:  {input_path}')
    print(f'Output: {output_path}')
    print(f'Total rows:                 {stats.total}')
    print(f'Kept rows:                  {stats.kept}')
    print(f'Skipped non-observer:       {stats.skipped_non_observer}')
    print(f'Skipped mixed observer pos: {stats.skipped_mixed_state}')
    print(f'Skipped downsampled:        {stats.skipped_downsample}')
    print(f'Skipped parse errors:       {stats.skipped_parse_error}')
    print(f'Skipped unsuccessful:       {stats.skipped_unsuccessful}')
    print(f'Skipped fallback source:    {stats.skipped_fallback_source}')
    print(f'Skipped state-only source:  {stats.skipped_state_only_source}')
    print(f'Skipped idle actions:       {stats.skipped_idle}')
    print(f'Skipped no state change:    {stats.skipped_no_state_change}')


if __name__ == '__main__':
    main()
