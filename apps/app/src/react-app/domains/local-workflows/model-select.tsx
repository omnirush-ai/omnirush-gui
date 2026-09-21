import type { LocalAvailableModel, LocalModelRef } from "@omnirush/types/local-workflows";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { dedupeModelOptions, resolveModelDisplayName, resolveModelProviderDisplayName } from "@/app/utils";
import { isSupportedModelProvider } from "@/app/lib/provider-catalog";

export function modelLabel(model: LocalModelRef) {
  return `${model.providerID} / ${resolveModelDisplayName(model.modelID)}`;
}

export function ModelSelect(props: {
  label: string;
  testId: string;
  models: LocalAvailableModel[];
  value: LocalModelRef | null;
  onChange: (value: LocalModelRef | null) => void;
  emptyLabel: string;
  disabled?: boolean;
}) {
  const key = (model: LocalModelRef) => `${model.providerID}/${model.modelID}`;
  const visibleModels = dedupeModelOptions(
    props.models.filter((model) => isSupportedModelProvider(model.providerID)).map((model) => ({
      ...model,
      title: resolveModelDisplayName(model.modelID, model.name),
    })),
  );
  const selectedKey = props.value ? key(props.value) : "";
  const unavailable = props.value && !visibleModels.some((model) => key(model) === selectedKey);
  const selectedModel = visibleModels.find((model) => key(model) === selectedKey);
  const selectedLabel = selectedModel ? `${resolveModelDisplayName(selectedModel.modelID, selectedModel.name)} · ${resolveModelProviderDisplayName(selectedModel.providerID, selectedModel.modelID, selectedModel.providerName, selectedModel.name)}` : props.value ? `${modelLabel(props.value)} (unavailable)` : props.emptyLabel;
  return (
    <div className="grid min-w-0 gap-1.5 text-sm">
      <span className="font-medium">{props.label}</span>
      <Select
        value={selectedKey}
        disabled={props.disabled}
        onValueChange={(value) => {
          if (value === "") { props.onChange(null); return; }
          const model = visibleModels.find((item) => key(item) === value);
          if (model) props.onChange({ providerID: model.providerID, modelID: model.modelID });
        }}
      >
        <SelectTrigger aria-label={props.label} data-testid={props.testId} className="w-full min-w-0 rounded-xl">
          <SelectValue><span className="truncate">{selectedLabel}</span></SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          <SelectItem value="" data-testid={`${props.testId}-option-auto`}>{props.emptyLabel}</SelectItem>
          {unavailable && props.value ? <SelectItem value={selectedKey} disabled>{modelLabel(props.value)} (unavailable)</SelectItem> : null}
          {visibleModels.map((model) => <SelectItem key={key(model)} value={key(model)} data-testid={`${props.testId}-option-${key(model)}`}>{model.title} · {resolveModelProviderDisplayName(model.providerID, model.modelID, model.providerName, model.name)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
