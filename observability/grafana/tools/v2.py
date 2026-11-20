"""Converte painéis no formato clássico (dict com type/targets/fieldConfig/gridPos) para o formato novo de
dashboard do Grafana 13 (dashboard.grafana.app/v2: elements + layout com abas e seções).

Estrutura de entrada do layout:
    tabs = [Tab("Resumo", [Section(None, [painel, ...]), Section("Fluxos", [...], collapse=False, only=("moeda", "zinthos"))])]
A posição de cada painel vem do gridPos (x, y relativos à seção; w, h)."""


class Section:
    def __init__(self, title, panels, collapse=False, only=None):
        self.title, self.panels, self.collapse, self.only = title, panels, collapse, only


class Tab:
    def __init__(self, title, sections, only=None):
        self.title, self.sections, self.only = title, sections, only


def _cond(only):
    """only = (variável, valor) ou (variável, valor, "notEquals")."""
    if not only:
        return None
    var, value, op = (*only, "equals")[:3]
    return {"kind": "ConditionalRenderingGroup", "spec": {"visibility": "show", "condition": "and", "items": [
        {"kind": "ConditionalRenderingVariable", "spec": {"variable": var, "operator": op, "value": value}}]}}


def _query(t):
    ds = t.get("datasource") or {}
    spec = {k: v for k, v in t.items() if k not in ("refId", "datasource")}
    return {"kind": "PanelQuery", "spec": {"query": {"kind": "DataQuery", "group": ds.get("type", ""), "version": "v0",
                                                        "datasource": {"name": ds.get("uid", "")}, "spec": spec},
                                             "refId": t.get("refId", "A"), "hidden": False}}


def element(p):
    el = _element(p)
    if p.get("transparent"):
        el["spec"]["transparent"] = True
    return el


def _element(p):
    qopts = {}
    if p.get("timeFrom"):
        qopts["timeFrom"] = p["timeFrom"]
    queries = [_query(t) for t in p.get("targets", [])]
    return {"kind": "Panel", "spec": {
        "id": p["id"], "title": p.get("title", ""), "description": p.get("description", ""), "links": p.get("links", []),
        "data": {"kind": "QueryGroup", "spec": {"queries": queries, "transformations": p.get("transformations", []),
                                                "queryOptions": qopts}},
        "vizConfig": {"kind": "VizConfig", "group": p["type"], "version": "",
                      "spec": {"options": p.get("options", {}),
                               "fieldConfig": p.get("fieldConfig", {"defaults": {}, "overrides": []})}}}}


def _grid(panels, elements):
    items = []
    base = min((p["gridPos"]["y"] for p in panels), default=0)
    for p in panels:
        name = f"panel-{p['id']}"
        elements[name] = element(p)
        g = p["gridPos"]
        spec = {"x": g["x"], "y": g["y"] - base, "width": g["w"], "height": g["h"],
                "element": {"kind": "ElementReference", "name": name}}
        if p.get("repeat"):  # {"mode": "variable", "value": <variável>, "direction": "h", "maxPerRow": n}
            spec["repeat"] = p["repeat"]
        items.append({"kind": "GridLayoutItem", "spec": spec})
    items.sort(key=lambda i: (i["spec"]["y"], i["spec"]["x"]))
    return {"kind": "GridLayout", "spec": {"items": items}}


def _section_layout(sections, elements):
    if len(sections) == 1 and sections[0].title is None and not sections[0].only:
        return _grid(sections[0].panels, elements)
    rows = []
    for s in sections:
        spec = {"title": s.title or "", "collapse": s.collapse, "layout": _grid(s.panels, elements)}
        if s.title is None:
            spec["hideHeader"] = True
        c = _cond(s.only)
        if c:
            spec["conditionalRendering"] = c
        rows.append({"kind": "RowsLayoutRow", "spec": spec})
    return {"kind": "RowsLayout", "spec": {"rows": rows}}


def dashboard(uid, title, *, tabs, description, tags, variables, annotations, links, time_from="now-7d", time_to="now"):
    elements = {}
    if len(tabs) == 1:
        layout = _section_layout(tabs[0].sections, elements)
    else:
        tl = []
        for t in tabs:
            spec = {"title": t.title, "layout": _section_layout(t.sections, elements)}
            c = _cond(t.only)
            if c:
                spec["conditionalRendering"] = c
            tl.append({"kind": "TabsLayoutTab", "spec": spec})
        layout = {"kind": "TabsLayout", "spec": {"tabs": tl}}
    return {
        "apiVersion": "dashboard.grafana.app/v2",
        "kind": "Dashboard",
        "metadata": {"name": uid},
        "spec": {
            "title": title, "description": description, "tags": tags, "editable": True, "cursorSync": "Crosshair",
            "liveNow": False, "preload": False, "links": links,
            "timeSettings": {"timezone": "browser", "from": time_from, "to": time_to, "autoRefresh": "",
                             "autoRefreshIntervals": ["5m", "15m", "1h"], "hideTimepicker": False,
                             "fiscalYearStartMonth": 0, "weekStart": "monday"},
            "variables": variables, "annotations": annotations, "elements": elements, "layout": layout,
        },
    }


def custom_var(name, label, options, current, multi=False, include_all=False):
    """options: [(texto, valor)]; current: valor ou lista de valores."""
    cur = current if isinstance(current, list) else [current]
    text = [t for t, v in options if v in cur]
    return {"kind": "CustomVariable", "spec": {
        "name": name, "label": label, "query": ",".join(f"{t} : {v}" for t, v in options),
        "current": {"text": text if multi else text[0], "value": cur if multi else cur[0]},
        "options": [{"selected": v in cur, "text": t, "value": v} for t, v in options],
        "multi": multi, "includeAll": include_all, "hide": "dontHide", "skipUrlSync": False, "allowCustomValue": False}}


def text_var(name, label):
    return {"kind": "TextVariable", "spec": {"name": name, "label": label, "query": "", "current": {"text": "", "value": ""},
                                              "hide": "dontHide", "skipUrlSync": False}}


def annotation(name, ds, sql, color, *, enable=True):
    return {"kind": "AnnotationQuery", "spec": {
        "query": {"kind": "DataQuery", "group": ds["type"], "version": "v0", "datasource": {"name": ds["uid"]},
                  "spec": {"queryType": "table", "queryText": sql, "rawQueryText": sql, "timeColumns": ["time"]}},
        "enable": enable, "hide": False, "iconColor": color, "name": name}}


BUILTIN_ANNOTATION = {"kind": "AnnotationQuery", "spec": {
    "query": {"kind": "DataQuery", "group": "grafana", "version": "v0", "datasource": {"name": "-- Grafana --"}, "spec": {}},
    "enable": True, "hide": True, "iconColor": "rgba(0, 211, 255, 1)", "name": "Annotations & Alerts", "builtIn": True,
    "legacyOptions": {"type": "dashboard"}}}


def link(title, url, tooltip):
    return {"title": title, "type": "link", "icon": "dashboard", "tooltip": tooltip, "url": url, "tags": [], "asDropdown": False,
            "targetBlank": False, "includeVars": False, "keepTime": True}
