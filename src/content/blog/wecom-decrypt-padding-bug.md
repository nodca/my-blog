---
title: "排查企业微信消息解密 invalid padding 错误"
description: "记录一次企业微信回调消息解密失败的排查过程，问题根源是企业微信的填充实现不符合标准 PKCS7 规范。"
pubDate: "2026-01-21"
categories:
  - 技术
  - 踩坑
tags:
  - 企业微信
  - Go
  - 加密解密
---

在开发企业微信应用的消息回调功能时，遇到了一个诡异的问题：只有 "hello" 和 "你好" 能正常解密，其他消息都报 `invalid padding` 错误。

## 问题现象

服务器日志显示：

```
wecom text from=CuiYiBo content="hello"           # 成功
wecom: decrypt failed err=wecom: invalid padding  # 失败
```

奇怪的是，Token 和 EncodingAESKey 配置都是正确的，签名验证也能通过，唯独解密失败。

## 排查过程

### 添加调试日志

为了定位问题，在解密函数中添加调试日志，打印解密后的原始数据：

```go
msgLen := binary.BigEndian.Uint32(debugPlain[16:20])
fmt.Printf("DEBUG msg content: %s\n", string(debugPlain[20:20+msgLen]))
fmt.Printf("DEBUG after msg: %x\n", debugPlain[20+msgLen:])
```

### 发现真相

调试输出揭示了问题：

```
DEBUG msg content: <xml>...<Content><![CDATA[测试123]]></Content>...</xml>
DEBUG after msg: 7777373631326232616334326339663732371e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e
```

消息内容完全正确！问题出在末尾的填充字节：

- corpID `ww7612b2ac42c9f727` 后面跟着 30 个 `0x1e` 字节
- `0x1e` = 30，表示填充长度是 30 字节
- 但 PKCS7 规范要求填充长度不能超过块大小（AES 是 16 字节）

## 根本原因

企业微信的加密实现**不遵循标准 PKCS7 填充规范**。标准 PKCS7 的填充值范围是 1-16，但企业微信可能产生超过 16 的填充值。

## 解决方案

不依赖 PKCS7 解填充，直接使用消息体中的 `msgLen` 字段定位数据：

```go
func (c *Crypto) Decrypt(encrypted string) ([]byte, error) {
    // ... AES-CBC 解密 ...

    // 直接根据 msgLen 提取消息，不使用 PKCS7 解填充
    msgLen := binary.BigEndian.Uint32(plain[16:20])
    msg := plain[20 : 20+int(msgLen)]

    // 根据最后一个字节确定填充长度，反推 corpID 位置
    padLen := int(plain[len(plain)-1])
    corpIDEnd := len(plain) - padLen
    appID := plain[20+int(msgLen) : corpIDEnd]

    if !bytes.Equal(appID, []byte(c.CorpID)) {
        return nil, errors.New("wecom: corpID mismatch")
    }
    return msg, nil
}
```

## 总结

这次排查的关键收获：

1. **不要假设第三方实现符合标准** — 即使是大厂的 API，也可能有非标准行为
2. **添加详细的调试日志** — 打印原始数据比猜测问题原因更有效
3. **理解协议格式** — 企业微信消息格式包含 msgLen 字段，可以绑过填充问题

希望这篇文章能帮到遇到同样问题的开发者。
