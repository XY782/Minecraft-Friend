from modules.training.artifacts import save_artifacts
from modules.training.cli import build_parser, parse_args
from modules.training.data import (
    apply_baseline_overrides,
    load_dataset,
    normalize_features,
    print_dataset_summary,
    shuffle_dataset,
    split_train_val,
    to_tensors,
)
from modules.training.engine import run_training_loop
from modules.training.modeling import (
    build_loss_functions,
    build_model,
    build_optimizer,
    build_scheduler,
    build_train_loader,
    compute_class_weights,
    resolve_device,
)


def train(args):
    apply_baseline_overrides(args)
    dataset_path, model_type, x, y, intent_y, control_y = load_dataset(args)
    x, y, intent_y, control_y = shuffle_dataset(x, y, intent_y, control_y, args.seed)

    n = len(x)
    train_split, val_split = split_train_val(x, y, intent_y, control_y)
    x_train, y_train, intent_train, control_train = train_split
    x_val, y_val, intent_val, control_val = val_split

    x_train, x_val, feature_mean, feature_std = normalize_features(x_train, x_val, model_type=model_type, args=args)
    tensors = to_tensors((x_train, y_train, intent_train, control_train), (x_val, y_val, intent_val, control_val))

    in_features = int(x.shape[-1])
    device = resolve_device(getattr(args, 'device', 'auto'))
    model = build_model(model_type, in_features, args).to(device)
    optimizer = build_optimizer(model, args)
    scheduler = build_scheduler(optimizer, args)

    class_weights = compute_class_weights(y_train, args)
    train_loader = build_train_loader(tensors, y_train, class_weights, int(args.batch_size), bool(args.oversample_meaningful))
    action_loss_fn, intent_loss_fn, control_loss_fn = build_loss_functions(args, intent_train, class_weights)
    action_loss_fn = action_loss_fn.to(device)
    intent_loss_fn = intent_loss_fn.to(device)
    control_loss_fn = control_loss_fn.to(device)

    print(f'training_device={device.type}')
    print_dataset_summary(args, n, in_features, model_type, y)

    result = run_training_loop(
        model=model,
        tensors=tensors,
        train_loader=train_loader,
        optimizer=optimizer,
        scheduler=scheduler,
        action_loss_fn=action_loss_fn,
        intent_loss_fn=intent_loss_fn,
        control_loss_fn=control_loss_fn,
        args=args,
        device=device,
    )

    save_artifacts(
        args,
        model,
        dataset_path,
        n,
        in_features,
        model_type,
        class_weights,
        feature_mean,
        feature_std,
        best_val_loss=result.get('best_val_loss'),
        best_epoch=result.get('best_epoch'),
    )


__all__ = ['build_parser', 'parse_args', 'train']
