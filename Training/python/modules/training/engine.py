import copy

import numpy as np
import torch
from torch.optim.lr_scheduler import ReduceLROnPlateau

from modules.training.modeling import compute_losses


def train_one_epoch(model, train_loader, optimizer, action_loss_fn, intent_loss_fn, control_loss_fn, args, device: torch.device):
    model.train()
    non_blocking = bool(getattr(args, 'non_blocking_transfer', True))
    totals = {'loss': [], 'action': [], 'intent': [], 'control': [], 'acc': [], 'intent_acc': [], 'grad_norm': []}
    for xb, yb, intent_b, control_b in train_loader:
        xb = xb.to(device, non_blocking=non_blocking)
        yb = yb.to(device, non_blocking=non_blocking)
        intent_b = intent_b.to(device, non_blocking=non_blocking)
        control_b = control_b.to(device, non_blocking=non_blocking)

        optimizer.zero_grad()
        total, action, intent, control, acc, intent_acc = compute_losses(
            model, xb, yb, intent_b, control_b, action_loss_fn, intent_loss_fn, control_loss_fn, args
        )
        if not torch.isfinite(total):
            print('warning=non_finite_loss_skipped_batch')
            continue

        total.backward()
        grad_norm = float(torch.nn.utils.clip_grad_norm_(model.parameters(), float(args.grad_clip_norm)).item())
        optimizer.step()

        totals['loss'].append(total.item())
        totals['action'].append(action.item())
        totals['intent'].append(intent.item())
        totals['control'].append(control.item())
        totals['acc'].append(acc.item())
        totals['intent_acc'].append(intent_acc.item())
        totals['grad_norm'].append(grad_norm)

    if not totals['loss']:
        raise RuntimeError('No valid training batches processed (all losses non-finite).')

    out = {k: float(np.mean(v)) for k, v in totals.items() if k != 'grad_norm'}
    grad_values = totals['grad_norm']
    out['grad_norm_mean'] = float(np.mean(grad_values))
    out['grad_norm_median'] = float(np.median(grad_values))
    out['grad_norm_max'] = float(np.max(grad_values))
    out['total'] = out['loss']
    return out


def evaluate(model, tensors, action_loss_fn, intent_loss_fn, control_loss_fn, args, device: torch.device):
    model.eval()
    non_blocking = bool(getattr(args, 'non_blocking_transfer', True))
    eval_batch_size = max(1, int(getattr(args, 'eval_batch_size', 0) or getattr(args, 'batch_size', 128)))
    n = int(tensors['x_val'].shape[0])

    loss_sum = 0.0
    action_sum = 0.0
    intent_sum = 0.0
    control_sum = 0.0
    acc_sum = 0.0
    intent_acc_sum = 0.0
    seen = 0

    with torch.no_grad():
        for start in range(0, n, eval_batch_size):
            end = min(n, start + eval_batch_size)
            batch_n = end - start

            total, action, intent, control, acc, intent_acc = compute_losses(
                model,
                tensors['x_val'][start:end].to(device, non_blocking=non_blocking),
                tensors['y_val'][start:end].to(device, non_blocking=non_blocking),
                tensors['intent_val'][start:end].to(device, non_blocking=non_blocking),
                tensors['control_val'][start:end].to(device, non_blocking=non_blocking),
                action_loss_fn,
                intent_loss_fn,
                control_loss_fn,
                args,
            )

            loss_sum += float(total.item()) * batch_n
            action_sum += float(action.item()) * batch_n
            intent_sum += float(intent.item()) * batch_n
            control_sum += float(control.item()) * batch_n
            acc_sum += float(acc.item()) * batch_n
            intent_acc_sum += float(intent_acc.item()) * batch_n
            seen += batch_n

    denom = max(1, seen)
    return {
        'loss': float(loss_sum / denom),
        'action': float(action_sum / denom),
        'intent': float(intent_sum / denom),
        'control': float(control_sum / denom),
        'acc': float(acc_sum / denom),
        'intent_acc': float(intent_acc_sum / denom),
    }


def _scheduler_step(scheduler, val_loss: float):
    if scheduler is None:
        return
    if isinstance(scheduler, ReduceLROnPlateau):
        scheduler.step(float(val_loss))
    else:
        scheduler.step()


def run_training_loop(model, tensors, train_loader, optimizer, scheduler, action_loss_fn, intent_loss_fn, control_loss_fn, args, device: torch.device):
    best_val_loss = float('inf')
    best_epoch = 0
    best_state_dict = None
    no_improve_epochs = 0

    for epoch in range(1, args.epochs + 1):
        train_metrics = train_one_epoch(model, train_loader, optimizer, action_loss_fn, intent_loss_fn, control_loss_fn, args, device=device)
        val_metrics = evaluate(model, tensors, action_loss_fn, intent_loss_fn, control_loss_fn, args, device=device)

        _scheduler_step(scheduler, val_metrics['loss'])
        current_lr = float(optimizer.param_groups[0]['lr'])

        min_delta = float(getattr(args, 'early_stopping_min_delta', 1e-6))
        improved = val_metrics['loss'] < best_val_loss - min_delta
        if improved:
            best_val_loss = float(val_metrics['loss'])
            best_epoch = int(epoch)
            best_state_dict = copy.deepcopy({k: v.detach().cpu().clone() for k, v in model.state_dict().items()})
            no_improve_epochs = 0
        else:
            no_improve_epochs += 1

        print(
            f'epoch={epoch} '
            f'train_loss={train_metrics["loss"]:.4f} '
            f'train_action={train_metrics["action"]:.4f} train_intent={train_metrics["intent"]:.4f} train_ctrl={train_metrics["control"]:.4f} '
            f'train_acc={train_metrics["acc"]:.4f} train_intent_acc={train_metrics["intent_acc"]:.4f} '
            f'train_grad_norm_mean={train_metrics["grad_norm_mean"]:.4f} train_grad_norm_median={train_metrics["grad_norm_median"]:.4f} train_grad_norm_max={train_metrics["grad_norm_max"]:.4f} '
            f'val_loss={val_metrics["loss"]:.4f} val_action={val_metrics["action"]:.4f} val_intent={val_metrics["intent"]:.4f} val_ctrl={val_metrics["control"]:.4f} '
            f'val_acc={val_metrics["acc"]:.4f} val_intent_acc={val_metrics["intent_acc"]:.4f} '
            f'lr={current_lr:.6g} best_val_loss={best_val_loss:.4f} best_epoch={best_epoch}'
        )

        if no_improve_epochs >= int(args.early_stopping_patience):
            print(f'early_stopping_triggered epoch={epoch} patience={int(args.early_stopping_patience)}')
            break

    if best_state_dict is not None:
        model.load_state_dict(best_state_dict)
        print(f'restored_best_checkpoint epoch={best_epoch} val_loss={best_val_loss:.4f}')

    return {'best_val_loss': best_val_loss, 'best_epoch': best_epoch}
