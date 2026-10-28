# 南方医科大学 · 随堂评价 一键连评

> 一个用于南方医科大学教务系统（`zhjw.smu.edu.cn`）的 Tampermonkey 用户脚本，
> 一键全自动完成「随堂评价」，适配本站 EasyUI 页面结构。

## 它做什么

点一下右下角的「一键连评」按钮，脚本会自动：

1. **搜索并进入**：在右上角搜索框输入「随堂评价」，点击下拉结果进入列表页；
2. **选日期 + 查询**：打开日期面板，点击标黄的「今天」，再点「查询」刷新列表；
3. **逐条评价**：循环点击列表里的「进入评价」，在弹出的评价表单中：
   - 随机挑 **1 题给 5 星**，其余题目给 **4 星**；
   - 单选题统一选 **「否」**（点完会核对 `radio.checked`，未勾选就强制勾选并派发 `change`）；
   - 点击「提交」，自动关闭「评价成功 / 确定」弹层；
4. **下一条**：列表行变成「已评价」后继续下一条，直到没有可评价的条目。

整个过程按钮点击后自动禁用，防止重复触发；每条结果都会在控制台打印 `[一键连评]` 日志，方便排查。

## 适配说明（本站 EasyUI 的坑都已处理）

- **搜索框**：`div.right-search-box > span.combo > input.combo-text`。EasyUI 的 combobox 只在 `keyup` 里做过滤，所以脚本采用「逐字输入 + 逐字 keyup」，只派发 `input/change` 是出不来下拉的。
- **日期框**：`span.combo.datebox > input.combo-text + span.combo-arrow`。EasyUI 的 class 是 `validatebox-text`（字符串里含 `datebox`），所以判断日期控件按 **class 词元**比对，不能用 `[class*=datebox]`。
- **弹窗**：`.window / .messager-window`，按钮 `.l-btn`，按钮容器 `.messager-button`。
- **日历面板**：`.combo-panel > .calendar`，今天/选中格为 `calendar-selected / calendar-today`，另用背景色兜底识别标黄日期。
- **单选「否」**：`<input type="radio" id="10002386"><label for="10002386">否</label>`。光点 label 可能被 `preventDefault`，所以点完必核对 `radio.checked`，没勾上就点 input 本身，再不行强制勾选 + 派发 `change`；提交前还会把仍然空着的单选组补上答案。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展；
2. 打开 [`smu-auto-eval.user.js`](./smu-auto-eval.user.js)，点 **Raw**，Tampermonkey 会自动弹出安装；
   或把 Raw 链接粘贴到 Tampermonkey 的「添加新脚本」中保存。

## 使用

1. 登录教务系统，打开任意页面；
2. 右下角出现「一键连评」悬浮按钮，点击它；
3. 之后全自动运行，按钮变灰禁用；完成后弹提示显示成功条数。

## 改版了怎么修

所有可调项集中在脚本顶部的 `CFG` 对象里：

| 现象 | 改哪里 |
|---|---|
| 搜索下拉里不叫「随堂评价」 | `CFG.KEYWORD` |
| 按钮不叫「进入评价」 | `CFG.ENTER_TEXT`（精确相等才算命中） |
| 提交按钮不叫「提交」 | `CFG.SUBMIT_TEXT`（包含即匹配） |
| 星星 title 不一样 | `CFG.HIGH_TITLE` / `CFG.NORMAL_TITLE` |
| 一条都没评上 | 打开控制台看 `[一键连评]` 日志，会打印每条定位结果 |

## 免责声明

本项目仅供**学习与个人效率交流**使用，请自行承担使用风险。建议仅在**本人账号、本人评价**上使用，不要用于刷评、代评等违规场景。作者不对因使用本脚本造成的任何后果负责。
