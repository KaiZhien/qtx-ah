import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { GoalPicker } from "../../components/patient/GoalPicker"

describe("GoalPicker", () => {
  it("renders both buttons", () => {
    render(<GoalPicker selected="pain" onChange={jest.fn()} />)
    expect(screen.getByText("Reduce my pain")).toBeInTheDocument()
    expect(screen.getByText("Move better")).toBeInTheDocument()
  })

  it("selected button has accent border", () => {
    render(<GoalPicker selected="pain" onChange={jest.fn()} />)
    const painBtn = screen.getByText("Reduce my pain").closest("button")!
    // JSDOM doesn't resolve CSS custom properties from the `border` shorthand,
    // so we inspect the raw `style` attribute which React sets as the `border` property.
    expect(painBtn.style.border).toContain("var(--accent)")
  })

  it("non-selected button has line border", () => {
    render(<GoalPicker selected="pain" onChange={jest.fn()} />)
    const mobilityBtn = screen.getByText("Move better").closest("button")!
    expect(mobilityBtn.style.border).toContain("var(--line)")
  })

  it("clicking non-selected calls onChange with 'mobility'", () => {
    const onChange = jest.fn()
    render(<GoalPicker selected="pain" onChange={onChange} />)
    fireEvent.click(screen.getByText("Move better").closest("button")!)
    expect(onChange).toHaveBeenCalledWith("mobility")
  })

  it("clicking selected still calls onChange with 'pain'", () => {
    const onChange = jest.fn()
    render(<GoalPicker selected="pain" onChange={onChange} />)
    fireEvent.click(screen.getByText("Reduce my pain").closest("button")!)
    expect(onChange).toHaveBeenCalledWith("pain")
  })

  it("both buttons have minHeight >= 56px", () => {
    render(<GoalPicker selected="pain" onChange={jest.fn()} />)
    const painBtn = screen.getByText("Reduce my pain").closest("button")!
    const mobilityBtn = screen.getByText("Move better").closest("button")!

    const toNumber = (v: string | number) =>
      typeof v === "number" ? v : parseFloat(v)

    expect(toNumber(painBtn.style.minHeight)).toBeGreaterThanOrEqual(56)
    expect(toNumber(mobilityBtn.style.minHeight)).toBeGreaterThanOrEqual(56)
  })
})
